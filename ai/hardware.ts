//
// ─── Deep hardware profiling ────────────────────────────────────────────────
//
// WHY THIS MODULE EXISTS
//
// `capacity.js` already answers "how long will this run take?" — but it only
// knows three things about the machine: core count, total RAM, and which of
// {metal, cuda, cpu} it is on. That is enough to estimate *time* and nowhere
// near enough to decide *which models are loadable at all*. Adding the Studio
// stack made that gap load-bearing: LTX-2.3 is a MEASURED 27.5 GB file, and
// offering it on a 16 GB laptop is not a slow run, it is a guaranteed failure
// after a very long download.
//
// So this module answers a different question: what is actually in this box?
//
// ─── PROVENANCE: keplerTR/LocalAI-Advisor (MIT) ─────────────────────────────
//
// Adapted from `src/hardware_scanner.py`. What was taken and what was not:
//
//   TAKEN — the GPU memory-bandwidth lookup table with fuzzy name matching and
//     a VRAM-derived fallback. Bandwidth predicts inference speed better than
//     any other single number (see advisor.ts) and cannot be queried portably,
//     so a table is the only practical route.
//   TAKEN — RAM bandwidth as MHz * 2 (DDR) * channels * 8 / 1000.
//   TAKEN — longest-key-first matching, so "4070 ti" cannot be shadowed by
//     "4070". Subtle enough to be asserted by a test rather than trusted.
//
//   NOT TAKEN — the Windows WMI/NVML layer via pywin32. This app ships
//     macOS/Windows/Linux Electron builds, so each platform gets its own probe
//     and every one may fail into a documented default.
//   NOT TAKEN — Ollama specifics and Hugging Face live sync. This app ships a
//     curated, pinned, verified registry on purpose; live catalogue lookups
//     would trade reproducibility for freshness we do not need.
//
// ─── DESIGN RULE ────────────────────────────────────────────────────────────
//
// Every probe degrades, never throws. This runs on the startup path, and a
// hardware probe that throws would take the app down on exactly the exotic
// machine it was meant to characterise. Failures return CONSERVATIVE values —
// "assume less machine" — so we under-promise rather than recommend something
// that cannot load.

import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface CpuFeatures { avx: boolean; avx2: boolean; avx512: boolean; neon: boolean }
export interface GpuInfo {
  vendor: string; name: string; vramGb: number; dedicated: boolean;
  unified?: boolean; bandwidthGbps: number; backend: 'cuda' | 'metal' | 'cpu';
  vramConfidence?: 'measured' | 'inferred';
}
export interface RamInfo {
  totalGb: number; freeGb: number; speedMhz: number; channels: number;
  type: string; bandwidthGbps: number; source: string;
}
export interface HardwareProfile {
  platform: string; arch: string;
  cpu: { model: string; cores: number; features: CpuFeatures };
  ram: RamInfo;
  gpus: GpuInfo[];
  primaryGpu: GpuInfo | null;
  totalVramGb: number;
  unifiedMemory: boolean;
  aiMemoryGb: number;
  freeDiskGb: number | null;
  backend: 'cuda' | 'metal' | 'cpu';
}

/**
 * Run a probe command, returning '' on any failure.
 *
 * The timeout is the important part: every probe here shells out to a vendor
 * tool that may be absent, refuse to run in a sandbox, or hang on a wedged
 * driver. Without a timeout one stuck `nvidia-smi` hangs app startup forever.
 */
function sh(cmd: string, timeout = 4000): string {
  try {
    return execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const GB = 1024 ** 3;
const toGb = (bytes: number): number => +(bytes / GB).toFixed(2);

// ─── GPU memory bandwidth table (GB/s) ──────────────────────────────────────
//
// WHY A TABLE: no cross-platform API reports memory bandwidth. nvidia-smi gives
// VRAM size but not bus bandwidth; Metal exposes neither. Bandwidth is a fixed
// property of a shipped SKU, so a lookup on the marketing name is accurate and
// free. Keys are lowercase substrings matched against the adapter name.
export const GPU_BANDWIDTH_GBPS: Record<string, number> = {
  // NVIDIA RTX 50 / 40 / 30 / 20 / GTX 16
  '5090': 1792, '5080': 960, '5070 ti': 896, '5070': 672, '5060 ti': 512, '5060': 384,
  '4090': 1008, '4080 super': 736, '4080': 717, '4070 ti super': 672,
  '4070 ti': 504, '4070 super': 504, '4070': 504, '4060 ti': 288, '4060': 272,
  '3090 ti': 1008, '3090': 936, '3080 ti': 912, '3080': 760,
  '3070 ti': 608, '3070': 448, '3060 ti': 448, '3060': 360,
  '2080 ti': 616, '2080 super': 496, '2080': 448, '2070 super': 448, '2070': 448, '2060': 336,
  '1660 ti': 288, '1660 super': 336, '1660': 192,
  // AMD RX 7000 / 6000
  '7900 xtx': 960, '7900 xt': 800, '7900 gre': 576, '7800 xt': 624, '7700 xt': 432, '7600': 288,
  '6950 xt': 576, '6900 xt': 512, '6800 xt': 512, '6800': 512, '6700 xt': 384, '6600 xt': 256,
  // Intel Arc
  'a770': 560, 'a750': 512, 'a580': 384, 'a380': 192,
  // Workstation / datacenter
  'a100': 2039, 'h100': 3352, 'a6000': 768, 'l40': 864, 'a40': 696,
  'rtx 6000 ada': 960, 'rtx 5000 ada': 768, 'rtx 4000 ada': 360,
  // Apple Silicon — NOT upstream (it is Windows-only) but the most likely
  // machine to run this app. Unified memory, so these are SoC totals.
  'm1 ultra': 800, 'm1 max': 400, 'm1 pro': 200, 'm1': 68,
  'm2 ultra': 800, 'm2 max': 400, 'm2 pro': 200, 'm2': 100,
  'm3 ultra': 819, 'm3 max': 400, 'm3 pro': 150, 'm3': 100,
  'm4 max': 546, 'm4 pro': 273, 'm4': 120,
};

/**
 * Memory bandwidth for a GPU, by fuzzy name match.
 *
 * Keys are tried LONGEST FIRST. Not cosmetic: "4070 ti" contains "4070", so
 * short-first iteration reports 504 GB/s for a 4070 Ti whose real figure is
 * 672 — a 33% under-estimate that would mis-rank every recommendation on that
 * card. Asserted by a test.
 *
 * The VRAM fallback exists because an unknown GPU is not an unknown machine: a
 * 24 GB card is a big card whatever it is called.
 */
export function gpuBandwidth(name: string, vramGb = 0): number {
  const n = String(name || '').toLowerCase();
  const keys = Object.keys(GPU_BANDWIDTH_GBPS).sort((a, b) => b.length - a.length);
  for (const k of keys) if (n.includes(k)) return GPU_BANDWIDTH_GBPS[k];

  if (vramGb >= 24) return 900;
  if (vramGb >= 16) return 600;
  if (vramGb >= 12) return 400;
  if (vramGb >= 8) return 300;
  if (vramGb >= 6) return 200;
  return 150;
}

/**
 * os.cpus() can legitimately return an EMPTY array — measured on this Android
 * sandbox, and it happens in containers and restricted VMs too. Floor at 1:
 * under-reporting only slows an estimate, zero breaks all downstream
 * arithmetic. Same bug and fix as capacity.js.
 */
export function cpuCount(): number {
  const n = os.cpus()?.length || 0;
  return n > 0 ? n : 1;
}

/**
 * Detect CPU vector extensions.
 *
 * WHY: llama.cpp / stable-diffusion.cpp CPU kernels are hand-vectorised, and
 * AVX2 vs baseline is roughly 1.5x throughput — the `cpuEfficiency` term in
 * advisor.ts. NEON is mandatory in ARMv8, so it is reported without probing.
 */
export function cpuFeatures(): CpuFeatures {
  const flags: CpuFeatures = { avx: false, avx2: false, avx512: false, neon: false };

  if (process.arch === 'arm64' || process.arch === 'arm') {
    flags.neon = true;
    return flags;
  }

  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
      flags.avx = info.includes(' avx');
      flags.avx2 = info.includes(' avx2');
      flags.avx512 = info.includes('avx512');
    } catch { /* /proc absent — leave false, the conservative direction */ }
  } else if (process.platform === 'darwin') {
    const s = sh('sysctl -n machdep.cpu.features machdep.cpu.leaf7_features').toLowerCase();
    flags.avx = s.includes('avx');
    flags.avx2 = s.includes('avx2');
    flags.avx512 = s.includes('avx512');
  } else if (process.platform === 'win32') {
    // No cheap flag query without native bindings. Infer from vintage: every
    // x64 part since ~2015 has AVX2, and being wrong costs an efficiency
    // coefficient, not correctness.
    flags.avx = true;
    flags.avx2 = true;
  }
  return flags;
}

/**
 * Estimate system RAM bandwidth (GB/s) as MHz * 2 * channels * 8 / 1000.
 *
 * This sets CPU inference speed, so it is worth getting roughly right. Where
 * the real clock cannot be read we assume DDR4-3200 dual-channel — the most
 * common laptop configuration, deliberately mid-range rather than optimistic.
 *
 * Apple Silicon is special-cased: unified memory bandwidth is a published SoC
 * property far above anything the DDR formula yields, shared by CPU and GPU.
 */
export function ramBandwidth(): Omit<RamInfo, 'totalGb' | 'freeGb'> {
  const dflt = { speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'assumed' };

  try {
    if (process.platform === 'darwin') {
      const brand = sh('sysctl -n machdep.cpu.brand_string');
      if (/Apple/i.test(brand)) {
        return {
          speedMhz: 0, channels: 0, type: 'Unified (Apple Silicon)',
          bandwidthGbps: gpuBandwidth(brand, 0), source: 'apple-soc',
        };
      }
    }

    if (process.platform === 'linux') {
      // dmidecode needs root; when unavailable we fall through to the
      // documented default rather than reporting a fabricated clock.
      const out = sh('dmidecode -t memory 2>/dev/null | grep -E "Speed|Type:"', 3000);
      const speeds = [...out.matchAll(/Speed:\s*(\d+)\s*MT\/s/gi)].map((m) => +m[1]);
      if (speeds.length) {
        const speed = Math.max(...speeds);
        const channels = Math.min(speeds.length, 4);
        return {
          speedMhz: speed, channels, type: /DDR5/i.test(out) ? 'DDR5' : 'DDR4',
          bandwidthGbps: +((speed * 2 * channels * 8) / 1000).toFixed(1), source: 'dmidecode',
        };
      }
    }

    if (process.platform === 'win32') {
      const out = sh('wmic memorychip get Speed,SMBIOSMemoryType /format:csv', 5000);
      const speeds = [...out.matchAll(/(\d{3,5})/g)].map((m) => +m[1]).filter((v) => v >= 800 && v <= 12000);
      if (speeds.length) {
        const speed = Math.max(...speeds);
        const channels = Math.min(speeds.length, 4);
        return {
          speedMhz: speed, channels, type: /34/.test(out) ? 'DDR5' : 'DDR4',
          bandwidthGbps: +((speed * 2 * channels * 8) / 1000).toFixed(1), source: 'wmic',
        };
      }
    }
  } catch { /* fall through */ }

  return dflt;
}

/**
 * Enumerate GPUs. Returns [] when there is no usable accelerator — an ordinary
 * outcome meaning "CPU only", not an error.
 */
export function detectGpus(): GpuInfo[] {
  const gpus: GpuInfo[] = [];

  // NVIDIA — the only broadly supported CUDA path for these engines.
  const nv = sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
  if (nv) {
    for (const line of nv.split('\n')) {
      const [name, mib] = line.split(',').map((s) => s.trim());
      if (!name) continue;
      const vramGb = +(Number(mib) / 1024).toFixed(2);
      gpus.push({
        vendor: 'NVIDIA', name, vramGb, dedicated: true,
        bandwidthGbps: gpuBandwidth(name, vramGb), backend: 'cuda',
        vramConfidence: 'measured',
      });
    }
    if (gpus.length) return gpus;
  }

  // Apple Silicon — unified memory, so "VRAM" is a share of system RAM. The
  // 0.75 factor reflects what Metal will actually let a process wire down;
  // claiming all of it would over-promise and get the process killed.
  if (process.platform === 'darwin') {
    const brand = sh('sysctl -n machdep.cpu.brand_string');
    if (/Apple/i.test(brand) || process.arch === 'arm64') {
      const totalGb = toGb(os.totalmem());
      gpus.push({
        vendor: 'Apple', name: brand || 'Apple Silicon',
        vramGb: +(totalGb * 0.75).toFixed(2), dedicated: false, unified: true,
        bandwidthGbps: gpuBandwidth(brand, totalGb), backend: 'metal',
        vramConfidence: 'measured',
      });
      return gpus;
    }
  }

  // Windows discrete GPU via WMI. AdapterRAM is a 32-bit field and therefore
  // WRONG (wraps) above 4 GB — upstream calls this "32-bit overflow
  // correction". We read only the name for the bandwidth table and let the
  // fallback infer size rather than trusting a number known to be broken.
  if (process.platform === 'win32') {
    const out = sh('wmic path win32_VideoController get Name /format:csv', 5000);
    for (const line of out.split('\n')) {
      const name = line.split(',').pop()?.trim();
      if (!name || /^Name$/i.test(name) || name.length < 3) continue;
      if (/basic (display|render)|remote|virtual|meta/i.test(name)) continue;
      const vendor = /nvidia/i.test(name) ? 'NVIDIA' : /amd|radeon/i.test(name) ? 'AMD'
        : /intel/i.test(name) ? 'Intel' : 'Unknown';
      const integrated = /intel.*(uhd|hd graphics|iris)|vega \d+ graphics|radeon graphics/i.test(name);
      gpus.push({
        vendor, name, vramGb: integrated ? 0 : 8, dedicated: !integrated,
        bandwidthGbps: gpuBandwidth(name, integrated ? 0 : 8),
        backend: vendor === 'NVIDIA' ? 'cuda' : 'cpu',
        vramConfidence: 'inferred',   // surfaced in the UI so it is not read as measured
      });
    }
  }

  return gpus;
}

/**
 * Free space on the models volume, in GB.
 *
 * WHY: LTX-2.3 distilled fp8 is a MEASURED 27.5 GB single file. Recommending a
 * stack that cannot fit wastes a very long download and fails at the worst
 * possible moment.
 *
 * Returns null when unknown. Callers MUST treat null as "unknown", never as
 * zero — zero would silently disable every model.
 */
export function freeDiskGb(dir: string): number | null {
  try {
    const anyFs = fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } };
    if (anyFs.statfsSync) {
      const s = anyFs.statfsSync(dir);          // Node 18.15+
      return toGb(s.bavail * s.bsize);
    }
  } catch { /* fall through */ }
  try {
    if (process.platform !== 'win32') {
      const out = sh(`df -k ${JSON.stringify(dir)}`);
      const avail = +(out.split('\n')[1] || '').split(/\s+/)[3];
      if (avail > 0) return toGb(avail * 1024);
    }
  } catch { /* fall through */ }
  return null;
}

let cachedProfile: HardwareProfile | null = null;

/**
 * Full hardware profile, cached.
 *
 * Called on the startup path and once per recommendation; shelling out to
 * nvidia-smi/wmic repeatedly would add visible UI latency for data that cannot
 * change while the app runs.
 */
export function profile(modelsDir?: string, force = false): HardwareProfile {
  if (cachedProfile && !force) return cachedProfile;

  const gpus = (() => { try { return detectGpus(); } catch { return [] as GpuInfo[]; } })();
  const ramInfo = (() => {
    try { return ramBandwidth(); } catch {
      return { speedMhz: 3200, channels: 2, type: 'DDR4', bandwidthGbps: 51.2, source: 'error-default' };
    }
  })();
  const features = (() => {
    try { return cpuFeatures(); } catch {
      return { avx: false, avx2: false, avx512: false, neon: false } as CpuFeatures;
    }
  })();

  const totalRamGb = toGb(os.totalmem());
  const primary = gpus[0] || null;

  // Aggregate VRAM across cards. Multi-GPU only helps if the runtime can split
  // a model across devices; sd.cpp and llama.cpp both can, so summing is fair.
  const totalVramGb = +gpus.filter((g) => g.dedicated || g.unified)
    .reduce((a, g) => a + g.vramGb, 0).toFixed(2);

  // "AI memory" = the pool a model may actually occupy. Dedicated VRAM counts
  // fully; system RAM counts only PARTIALLY (0.65) because the OS, Electron and
  // ffmpeg all need headroom and a model sized to total RAM would swap — which
  // on these workloads is indistinguishable from a hang. Unified memory is not
  // double-counted: its vramGb is already a slice of totalRamGb.
  const unified = !!primary?.unified;
  const aiMemoryGb = unified
    ? +(totalRamGb * 0.75).toFixed(2)
    : +(totalVramGb + totalRamGb * 0.65).toFixed(2);

  cachedProfile = {
    platform: process.platform,
    arch: process.arch,
    cpu: { model: os.cpus()[0]?.model?.trim() || 'Unknown CPU', cores: cpuCount(), features },
    ram: { totalGb: totalRamGb, freeGb: toGb(os.freemem()), ...ramInfo },
    gpus,
    primaryGpu: primary,
    totalVramGb,
    unifiedMemory: unified,
    aiMemoryGb,
    freeDiskGb: modelsDir ? freeDiskGb(modelsDir) : null,
    // The backend the engines will use. capacity.js keys its cost table on this
    // same vocabulary, so the two modules agree by construction.
    backend: primary?.backend || 'cpu',
  };
  return cachedProfile;
}

/** Reset the cache. Tests only — hardware does not change at runtime. */
export function _resetCache(): void { cachedProfile = null; }
