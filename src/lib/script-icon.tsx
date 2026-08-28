/**
 * Vector icons a script can pick in pyshell.yaml via `icon: lucide:<name>`.
 *
 * `<name>` must be one of ICON_NAMES below — a curated subset of
 * https://lucide.dev/icons, sourced from `lucide-preact`. Anything else (a
 * bare emoji, a symbol, or an unknown/misspelled lucide name) renders as
 * literal text, which is what every manifest already did before this map
 * existed — so old `icon: 🔧` manifests are unaffected.
 */
import {
  Activity, Archive, Bell, Bot, Brain, Bug, Calculator, Calendar, Camera,
  ChartBar, ChartLine, ChartPie, Check, CircleCheck, CircleHelp, CircleX,
  Clock, Cloud, CloudDownload, CloudUpload, Code, Compass, Copy, Cpu,
  Database, DollarSign, Download, Eye, FileCode, FileJson, FileText, File,
  Filter, Flag, FlaskConical, Folder, FolderOpen, GitBranch, GitCommit,
  Globe, HardDrive, Hash, Heart, Home, Image, Info, Key, Layers,
  LayoutGrid, Link, List, Lock, Mail, Map, MapPin, MessageSquare, Mic,
  Monitor, Music, Package, Pause, Play, Printer, RefreshCw, RotateCw,
  Rocket, Save, Search, Send, Server, Settings, Shield, ShieldCheck,
  SlidersHorizontal,
  Smartphone, Sparkles, Square, Star, Table, Target, Terminal, Timer,
  Trash2, TrendingDown, TrendingUp, TriangleAlert, Upload, User, Users,
  Video, Webhook, Wifi, Wrench, Zap, type LucideIcon,
} from "lucide-preact";

const PREFIX = "lucide:";

const ICONS: Record<string, LucideIcon> = {
  file: File, "file-text": FileText, "file-code": FileCode, "file-json": FileJson,
  folder: Folder, "folder-open": FolderOpen, archive: Archive, terminal: Terminal,
  code: Code, "git-branch": GitBranch, "git-commit": GitCommit, package: Package,
  database: Database, server: Server,
  globe: Globe, cloud: Cloud, "cloud-upload": CloudUpload, "cloud-download": CloudDownload,
  wifi: Wifi, link: Link, webhook: Webhook,
  mail: Mail, send: Send, bell: Bell, "message-square": MessageSquare,
  play: Play, pause: Pause, square: Square, "refresh-cw": RefreshCw, "rotate-cw": RotateCw,
  download: Download, upload: Upload, save: Save, copy: Copy, trash: Trash2,
  search: Search, filter: Filter, settings: Settings, sliders: SlidersHorizontal, wrench: Wrench,
  check: Check, "check-circle": CircleCheck, "x-circle": CircleX, "alert-triangle": TriangleAlert,
  info: Info, "help-circle": CircleHelp, flag: Flag, star: Star, heart: Heart,
  shield: Shield, "shield-check": ShieldCheck, lock: Lock, key: Key, bug: Bug,
  user: User, users: Users, eye: Eye,
  "bar-chart": ChartBar, "pie-chart": ChartPie, "line-chart": ChartLine,
  "trending-up": TrendingUp, "trending-down": TrendingDown, activity: Activity,
  table: Table, list: List, layers: Layers, grid: LayoutGrid,
  zap: Zap, bot: Bot, brain: Brain, sparkles: Sparkles, "flask-conical": FlaskConical,
  calculator: Calculator, hash: Hash, "dollar-sign": DollarSign, clock: Clock, timer: Timer,
  calendar: Calendar, image: Image, camera: Camera, video: Video, music: Music, mic: Mic,
  printer: Printer, monitor: Monitor, smartphone: Smartphone, cpu: Cpu, "hard-drive": HardDrive,
  map: Map, "map-pin": MapPin, compass: Compass, target: Target, home: Home, rocket: Rocket,
};

/** Names accepted after `lucide:` in a manifest's `icon` field, for docs. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS).sort();

interface ScriptIconProps {
  icon?: string | null;
  size?: number;
  class?: string;
}

/**
 * Renders a script's manifest `icon` value: a recognised `lucide:<name>`
 * becomes a themed vector icon; everything else (emoji, symbol, unknown
 * name) renders as text, exactly as it always did.
 */
export function ScriptIcon({ icon, size = 16, class: className = "" }: ScriptIconProps) {
  const Vector = icon?.startsWith(PREFIX) ? ICONS[icon.slice(PREFIX.length)] : undefined;
  if (Vector) return <Vector size={size} class={className} />;
  return (
    <span class={`leading-none ${className}`} style={{ fontSize: size }}>
      {icon ?? "📄"}
    </span>
  );
}
