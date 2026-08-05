import { useState, useEffect, useRef, useMemo } from 'react';
import {
  ScanSearch,
  Upload,
  Sparkles,
  Play,
  VolumeX,
  Scissors,
  ChevronDown,
  ChevronUp,
  Trash2,
  Filter,
  Clock,
  Zap,
  Film,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { tw, typography } from '../../lib/colors';

/* Clip Sense — AI-powered footage analysis for Byorn editors.
 * Uses Gemini video understanding + WorkspaceDB persistence. */

type MomentType = 'highlight' | 'silence' | 'cut_point';
type SortKey = 'timestamp' | 'confidence' | 'type';
type SortDir = 'asc' | 'desc';

interface ClipScan {
  id: number;
  file_name: string;
  file_size?: number;
  status: string;
  moment_count?: number;
  created_at?: string;
}

interface ClipMoment {
  id: number;
  scan_id: number;
  timestamp_sec: number;
  end_timestamp_sec?: number | null;
  moment_type: MomentType;
  label: string;
  confidence: number;
  description?: string;
  created_at?: string;
}

declare global {
  interface Window {
    useWorkspaceDB: <T = any>(
      table: string,
      options?: {
        shared?: boolean;
        limit?: number;
        offset?: number;
        orderBy?: { column: string; direction: 'asc' | 'desc' };
        filters?: Array<{ column: string; operator: string; value: any }>;
      }
    ) => { data: T[]; loading: boolean; error: Error | null; total: number; refresh: () => void };
    __workspaceDb: any;
    __WORKSPACE_ID__?: string;
  }
}

const ANALYSIS_PROMPT = `You are a professional video editor analyzing raw footage for clip extraction.

Return ONLY valid JSON (no markdown fences, no commentary) with this exact structure:
{
  "moments": [
    {
      "timestamp": "MM:SS",
      "end_timestamp": "MM:SS or null",
      "type": "highlight",
      "label": "Short punchy title",
      "confidence": 85,
      "description": "Why this moment is actionable for an editor"
    }
  ]
}

Identify these moment types:
- "highlight": Best clip-worthy moments — strong quotes, reactions, insights, hooks. Find the top 8 maximum.
- "silence": Dead air, long pauses, awkward gaps, filler words worth cutting out.
- "cut_point": Natural edit boundaries — sentence ends, topic shifts, caption-ready break points.

Rules:
- confidence is 0-100 (how sure you are this moment matters)
- Use precise timestamps from the actual video
- Sort moments chronologically
- Be specific in labels — editors need to scan fast`;

const TYPE_META: Record<
  MomentType,
  { label: string; icon: typeof Sparkles; badge: string; glow: string }
> = {
  highlight: {
    label: 'Highlight',
    icon: Sparkles,
    badge: `${tw.badge.default} ${tw.badge.primary}`,
    glow: 'shadow-[0_0_12px_var(--space-brand-primary-200)]',
  },
  silence: {
    label: 'Silence',
    icon: VolumeX,
    badge: `${tw.badge.default} ${tw.badge.neutral}`,
    glow: '',
  },
  cut_point: {
    label: 'Cut Point',
    icon: Scissors,
    badge: `${tw.badge.default} ${tw.badge.accent}`,
    glow: 'shadow-[0_0_10px_var(--space-brand-highlight-200)]',
  },
};

function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(ts) || 0;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseAnalysisResult(raw: string): Omit<ClipMoment, 'id' | 'scan_id' | 'created_at'>[] {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.moments && Array.isArray(parsed.moments)) {
      return parsed.moments.map((m: any) => ({
        timestamp_sec: parseTimestamp(m.timestamp || '0:00'),
        end_timestamp_sec: m.end_timestamp ? parseTimestamp(m.end_timestamp) : null,
        moment_type: (['highlight', 'silence', 'cut_point'].includes(m.type) ? m.type : 'highlight') as MomentType,
        label: m.label || 'Untitled moment',
        confidence: Math.min(100, Math.max(0, Number(m.confidence) || 70)),
        description: m.description || '',
      }));
    }
  } catch {
    /* fall through to line parser */
  }

  const moments: Omit<ClipMoment, 'id' | 'scan_id' | 'created_at'>[] = [];
  const lines = cleaned.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const match = line.match(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*(.+)/);
    if (match) {
      const lower = match[2].toLowerCase();
      let type: MomentType = 'highlight';
      if (lower.includes('silence') || lower.includes('pause') || lower.includes('dead')) type = 'silence';
      else if (lower.includes('cut') || lower.includes('transition') || lower.includes('caption')) type = 'cut_point';
      moments.push({
        timestamp_sec: parseTimestamp(match[1]),
        end_timestamp_sec: null,
        moment_type: type,
        label: match[2].slice(0, 80),
        confidence: 75,
        description: match[2],
      });
    }
  }
  return moments;
}

async function analyzeVideo(file: File): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('prompt', ANALYSIS_PROMPT);
  const response = await fetch('/api/generate/video-analysis', { method: 'POST', body: formData });
  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Video analysis failed');
  return data.result;
}

function WaveformStrip({ active, progress }: { active: boolean; progress: number }) {
  const bars = 48;
  return (
    <div className="relative h-16 flex items-end gap-[2px] px-1 overflow-hidden rounded-xl bg-[var(--space-surface-muted)] border border-[var(--space-border-default)]">
      {Array.from({ length: bars }).map((_, i) => {
        const h = 20 + Math.sin(i * 0.7) * 14 + Math.cos(i * 1.3) * 10;
        const lit = active && i / bars <= progress;
        return (
          <div
            key={i}
            className="flex-1 rounded-full transition-all duration-300"
            style={{
              height: `${h}%`,
              backgroundColor: lit
                ? 'var(--space-brand-primary)'
                : 'color-mix(in srgb, var(--space-brand-primary) 25%, transparent)',
              opacity: active ? (lit ? 1 : 0.35) : 0.5,
            }}
          />
        );
      })}
      {active && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-[var(--space-brand-highlight)] shadow-[0_0_8px_var(--space-brand-highlight)] transition-all duration-500"
          style={{ left: `${Math.min(progress * 100, 99)}%` }}
        />
      )}
    </div>
  );
}

export default function ClipSense() {
  const { data: scans, loading: scansLoading, error: scansError, refresh: refreshScans } =
    window.useWorkspaceDB<ClipScan>('clip_scans', {
      orderBy: { column: 'created_at', direction: 'desc' },
      limit: 20,
    });

  const [activeScanId, setActiveScanId] = useState<number | null>(null);
  const { data: moments, loading: momentsLoading, error: momentsError, refresh: refreshMoments } =
    window.useWorkspaceDB<ClipMoment>('clip_moments', {
      orderBy: { column: 'timestamp_sec', direction: 'asc' },
      limit: 200,
      filters: activeScanId ? [{ column: 'scan_id', operator: 'eq', value: activeScanId }] : [],
    });

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [typeFilter, setTypeFilter] = useState<MomentType | 'all'>('all');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (scans?.length && !activeScanId) {
      setActiveScanId(scans[0].id);
    }
  }, [scans, activeScanId]);

  useEffect(() => {
    return () => {
      if (videoPreview) URL.revokeObjectURL(videoPreview);
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, [videoPreview]);

  const sortedMoments = useMemo(() => {
    if (!activeScanId) return [];
    let list = [...(moments || [])];
    if (typeFilter !== 'all') list = list.filter((m) => m.moment_type === typeFilter);
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'timestamp') cmp = a.timestamp_sec - b.timestamp_sec;
      else if (sortKey === 'confidence') cmp = a.confidence - b.confidence;
      else cmp = a.moment_type.localeCompare(b.moment_type);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [moments, sortKey, sortDir, typeFilter, activeScanId]);

  const stats = useMemo(() => {
    const all = moments || [];
    return {
      highlights: all.filter((m) => m.moment_type === 'highlight').length,
      silences: all.filter((m) => m.moment_type === 'silence').length,
      cuts: all.filter((m) => m.moment_type === 'cut_point').length,
    };
  }, [moments]);

  const handleFileSelect = (file: File) => {
    if (videoPreview) URL.revokeObjectURL(videoPreview);
    setVideoFile(file);
    setVideoPreview(URL.createObjectURL(file));
    setAnalyzeError('');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('video/')) handleFileSelect(file);
  };

  const handleAnalyze = async () => {
    if (!videoFile || analyzing) return;
    setAnalyzing(true);
    setAnalyzeError('');
    setAnalyzeProgress(0);

    progressTimer.current = setInterval(() => {
      setAnalyzeProgress((p) => Math.min(p + 0.02, 0.92));
    }, 400);

    let scanId: number | null = null;
    try {
      await window.__workspaceDb.from('clip_scans').insert({
        file_name: videoFile.name,
        file_size: videoFile.size,
        status: 'processing',
        moment_count: 0,
      });

      const { data: latestScans } = await window.__workspaceDb
        .from('clip_scans')
        .orderBy('created_at', 'desc')
        .limit(1)
        .get();
      scanId = latestScans?.[0]?.id ?? null;
      if (!scanId) throw new Error('Failed to create scan record');

      const raw = await analyzeVideo(videoFile);
      setAnalyzeProgress(0.95);

      const parsed = parseAnalysisResult(raw);
      if (parsed.length === 0) throw new Error('No edit moments detected — try a longer clip with speech.');

      await window.__workspaceDb.from('clip_moments').bulkInsert(
        parsed.map((m) => ({ ...m, scan_id: scanId }))
      );

      await window.__workspaceDb.from('clip_scans').update(scanId!, {
        status: 'complete',
        moment_count: parsed.length,
      });

      setAnalyzeProgress(1);
      setActiveScanId(scanId!);
      refreshScans();
      refreshMoments();
    } catch (err) {
      if (scanId) {
        await window.__workspaceDb.from('clip_scans').update(scanId, { status: 'error' });
        refreshScans();
      }
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      if (progressTimer.current) clearInterval(progressTimer.current);
      setAnalyzing(false);
      setTimeout(() => setAnalyzeProgress(0), 800);
    }
  };

  const handleDeleteScan = async (id: number) => {
    const scanMoments = (moments || []).filter((m) => m.scan_id === id);
    for (const m of scanMoments) {
      await window.__workspaceDb.from('clip_moments').delete(m.id);
    }
    await window.__workspaceDb.from('clip_scans').delete(id);
    if (activeScanId === id) setActiveScanId(scans?.find((s) => s.id !== id)?.id ?? null);
    refreshScans();
    refreshMoments();
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'confidence' ? 'desc' : 'asc');
    }
  };

  const copyTimestamp = (m: ClipMoment) => {
    const text = m.end_timestamp_sec
      ? `${formatTimestamp(m.timestamp_sec)} – ${formatTimestamp(m.end_timestamp_sec)}`
      : formatTimestamp(m.timestamp_sec);
    navigator.clipboard.writeText(text);
    setCopiedId(m.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const activeScan = scans?.find((s) => s.id === activeScanId);

  return (
    <div className="min-h-full flex flex-col w-full bg-transparent">
      {/* Upload zone */}
      <div className="px-5 pt-4 pb-3 border-b border-[var(--space-border-default)]">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className={`text-xs font-medium uppercase tracking-wider ${typography.color.brand}`}>
              Edit at the speed of thought
            </p>
            <p className="text-sm text-[var(--space-text-secondary)] mt-0.5">
              Drop raw footage — get timestamped highlights, silences & cut points
            </p>
          </div>
          <div className={`p-2 rounded-xl ${tw.bg.muted} border border-[var(--space-border-default)]`}>
            <ScanSearch className={`w-5 h-5 ${tw.icon.primary}`} />
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFileSelect(f);
          }}
        />

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => !analyzing && fileInputRef.current?.click()}
          className={`relative rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer overflow-hidden
            ${videoFile ? 'border-[var(--space-brand-primary-500)]/50' : 'border-[var(--space-border-default)] hover:border-[var(--space-brand-primary-500)]/40'}
            ${tw.bg.muted} ${analyzing ? 'pointer-events-none opacity-80' : ''}`}
        >
          <div className="p-5">
            {videoFile ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${tw.bg.card} border border-[var(--space-border-default)]`}>
                    <Film className={`w-5 h-5 ${tw.icon.primary}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--space-text-primary)] truncate">{videoFile.name}</p>
                    <p className="text-xs text-[var(--space-text-muted)]">
                      {(videoFile.size / 1024 / 1024).toFixed(1)} MB · ready to scan
                    </p>
                  </div>
                </div>
                {videoPreview && (
                  <video src={videoPreview} controls className="w-full rounded-xl max-h-36 object-cover" />
                )}
                <WaveformStrip active={analyzing} progress={analyzeProgress} />
              </div>
            ) : (
              <div className="flex flex-col items-center py-6 gap-2 text-center">
                <div className={`p-3 rounded-2xl ${tw.bg.card} border border-[var(--space-border-default)]`}>
                  <Upload className={`w-6 h-6 ${tw.icon.primary}`} />
                </div>
                <p className="text-sm font-medium text-[var(--space-text-primary)]">Drop your footage here</p>
                <p className="text-xs text-[var(--space-text-muted)]">MP4, WebM, MOV · up to 2GB</p>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleAnalyze}
          disabled={!videoFile || analyzing}
          className={`mt-3 w-full py-2.5 px-4 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-200
            ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {analyzing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning footage… {Math.round(analyzeProgress * 100)}%
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              Run Clip Sense
            </>
          )}
        </button>

        {analyzeError && (
          <p className="mt-2 text-xs text-[var(--space-semantic-danger)]">{analyzeError}</p>
        )}
      </div>

      {/* Scan history pills */}
      {scans && scans.length > 0 && (
        <div className="px-5 py-2 flex gap-2 overflow-x-auto border-b border-[var(--space-border-default)]">
          {scans.map((scan) => (
            <button
              key={scan.id}
              onClick={() => setActiveScanId(scan.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all shrink-0
                ${activeScanId === scan.id
                  ? `${tw.badge.primary} ring-1 ring-[var(--space-brand-primary-500)]/30`
                  : `${tw.badge.neutral} hover:brightness-95`}`}
            >
              <Film className="w-3 h-3" />
              {scan.file_name.length > 22 ? scan.file_name.slice(0, 20) + '…' : scan.file_name}
              {scan.moment_count != null && (
                <span className="opacity-70">({scan.moment_count})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Stats + filters */}
      {activeScan && (
        <div className="px-5 py-3 flex flex-wrap items-center gap-2 border-b border-[var(--space-border-default)]">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${tw.bg.card} border border-[var(--space-border-default)]`}>
            <Sparkles className={`w-3.5 h-3.5 ${tw.icon.primary}`} />
            <span className="text-[var(--space-text-primary)] font-medium">{stats.highlights}</span>
            <span className="text-[var(--space-text-muted)]">highlights</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${tw.bg.card} border border-[var(--space-border-default)]`}>
            <VolumeX className={`w-3.5 h-3.5 ${tw.icon.neutral}`} />
            <span className="text-[var(--space-text-primary)] font-medium">{stats.silences}</span>
            <span className="text-[var(--space-text-muted)]">silences</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${tw.bg.card} border border-[var(--space-border-default)]`}>
            <Scissors className={`w-3.5 h-3.5 ${tw.icon.accent}`} />
            <span className="text-[var(--space-text-primary)] font-medium">{stats.cuts}</span>
            <span className="text-[var(--space-text-muted)]">cut points</span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Filter className={`w-3.5 h-3.5 ${tw.icon.muted}`} />
            {(['all', 'highlight', 'silence', 'cut_point'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors
                  ${typeFilter === t ? `${tw.badge.primary}` : 'text-[var(--space-text-muted)] hover:text-[var(--space-text-secondary)]'}`}
              >
                {t === 'all' ? 'All' : TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sort bar */}
      {sortedMoments.length > 0 && (
        <div className="px-5 py-2 flex gap-2 text-[11px]">
          {(['timestamp', 'confidence', 'type'] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={`flex items-center gap-0.5 px-2 py-1 rounded-md font-medium transition-colors
                ${sortKey === key ? `${tw.badge.primary}` : 'text-[var(--space-text-muted)] hover:text-[var(--space-text-secondary)]'}`}
            >
              {key === 'timestamp' ? 'Time' : key === 'confidence' ? 'Confidence' : 'Type'}
              {sortKey === key && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
            </button>
          ))}
          {activeScan && (
            <button
              onClick={() => handleDeleteScan(activeScan.id)}
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-[var(--space-text-muted)] hover:text-[var(--space-semantic-danger)] transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Clear scan
            </button>
          )}
        </div>
      )}

      {/* Moments list */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {(scansLoading || momentsLoading) && !sortedMoments.length ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className={`w-7 h-7 animate-spin ${tw.icon.primary}`} />
            <p className="text-sm text-[var(--space-text-muted)]">Loading your scans…</p>
          </div>
        ) : scansError || momentsError ? (
          <div className="text-center py-14">
            <p className="text-sm text-[var(--space-semantic-danger)]">
              Couldn't load data: {(scansError || momentsError)?.message}
            </p>
          </div>
        ) : !activeScan && !videoFile ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <div className={`p-4 rounded-2xl ${tw.bg.muted} border border-[var(--space-border-default)] relative`}>
              <ScanSearch className={`w-8 h-8 ${tw.icon.primary}`} />
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[var(--space-brand-highlight)] animate-pulse shadow-[0_0_8px_var(--space-brand-highlight)]" />
            </div>
            <p className="text-sm font-medium text-[var(--space-text-primary)]">No scans yet</p>
            <p className="text-xs text-[var(--space-text-muted)] max-w-xs">
              Upload a podcast, interview, or raw clip — Clip Sense finds your best edit moments before your coffee's done.
            </p>
          </div>
        ) : sortedMoments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 gap-2 text-center">
            <Clock className={`w-6 h-6 ${tw.icon.muted}`} />
            <p className="text-sm text-[var(--space-text-muted)]">
              {analyzing ? 'AI is mapping your timeline…' : 'Run a scan to see edit moments here'}
            </p>
          </div>
        ) : (
          <ul className="space-y-2 pb-4">
            {sortedMoments.map((moment, idx) => {
              const meta = TYPE_META[moment.moment_type];
              const Icon = meta.icon;
              return (
                <li
                  key={moment.id}
                  className={`group relative rounded-xl border border-[var(--space-border-default)] ${tw.bg.card}
                    hover:border-[var(--space-brand-primary-500)]/40 transition-all duration-200
                    ${moment.moment_type === 'highlight' ? meta.glow : ''}`}
                  style={{ animationDelay: `${idx * 40}ms` }}
                >
                  <div className="flex items-start gap-3 p-3.5">
                    {/* Timestamp rail */}
                    <div className="flex flex-col items-center gap-1 shrink-0 w-14">
                      <button
                        onClick={() => copyTimestamp(moment)}
                        className={`font-mono text-sm font-semibold ${typography.color.brand} hover:opacity-80 transition-opacity flex items-center gap-0.5`}
                        title="Copy timestamp"
                      >
                        {formatTimestamp(moment.timestamp_sec)}
                        {copiedId === moment.id ? (
                          <Check className="w-3 h-3 text-[var(--space-semantic-success)]" />
                        ) : (
                          <Copy className="w-3 h-3 opacity-0 group-hover:opacity-50" />
                        )}
                      </button>
                      {moment.end_timestamp_sec != null && moment.end_timestamp_sec > moment.timestamp_sec && (
                        <span className="font-mono text-[10px] text-[var(--space-text-muted)]">
                          → {formatTimestamp(moment.end_timestamp_sec)}
                        </span>
                      )}
                      <div className="w-px flex-1 min-h-[8px] bg-gradient-to-b from-[var(--space-brand-primary)] to-transparent opacity-40" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={meta.badge}>
                          <Icon className="w-3 h-3 inline mr-1 -mt-0.5" />
                          {meta.label}
                        </span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${tw.bg.muted} text-[var(--space-text-secondary)]`}>
                          {moment.confidence}% sure
                        </span>
                      </div>
                      <p className="text-sm font-medium text-[var(--space-text-primary)] leading-snug">
                        {moment.label}
                      </p>
                      {moment.description && moment.description !== moment.label && (
                        <p className="text-xs text-[var(--space-text-secondary)] mt-1 line-clamp-2">
                          {moment.description}
                        </p>
                      )}
                    </div>

                    {/* Confidence bar */}
                    <div className="hidden sm:flex flex-col items-end gap-1 shrink-0 w-16">
                      <div className="w-full h-1.5 rounded-full bg-[var(--space-surface-muted)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${moment.confidence}%`,
                            backgroundColor:
                              moment.confidence >= 80
                                ? 'var(--space-brand-primary)'
                                : moment.confidence >= 60
                                  ? 'var(--space-brand-highlight-500)'
                                  : 'var(--space-text-muted)',
                          }}
                        />
                      </div>
                      <Play className={`w-3.5 h-3.5 ${tw.icon.muted} opacity-0 group-hover:opacity-60 transition-opacity`} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
