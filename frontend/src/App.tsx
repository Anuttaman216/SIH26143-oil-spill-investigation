import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Anchor, Database, FileText, Layers as LayersIcon, Maximize2, Radar, Ship, Waves } from "lucide-react";
import { Toaster, toast } from "sonner";
import { api, BBox, Candidate, Layers, ProgressEvent, Scene, Source, TriageRow } from "@/api";
import MapView, { LayerKey, TimeCursor } from "@/components/MapView";
import {
  CandidatesPanel, EvidencePanel, InvestigationPanel, LayerMenu, ProgressCard, Prov, SearchPanel, SlickDetail,
  SourcesSheet, Timeline, TriagePanel,
} from "@/components/panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const VISIBLE: Record<LayerKey, boolean> = {
  sar: true, slicks: true, selected: true, particles: true, heatmap: true, regions: true, ais: true, vessels: true,
  forward: true, sarships: true,
};
const STEPS = [
  { key: "search", label: "Area & scene", icon: Radar },
  { key: "triage", label: "Detection & triage", icon: Waves },
  { key: "investigation", label: "Hindcast", icon: Anchor },
  { key: "candidates", label: "Candidates", icon: Ship },
  { key: "evidence", label: "Evidence", icon: FileText },
] as const;
type Tab = typeof STEPS[number]["key"];

export default function App() {
  const [health, setHealth] = useState<any>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [analyses, setAnalyses] = useState<any[]>([]);
  const [aid, setAid] = useState<string | null>(null);
  const [data, setData] = useState<Layers | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("search");
  const [aoi, setAoi] = useState<BBox | null>([11.0, 56.2, 12.0, 56.8]);
  const [drawing, setDrawing] = useState(false);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [focusRow, setFocusRow] = useState<TriageRow | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [visible, setVisible] = useState(VISIBLE);
  const [layersOpen, setLayersOpen] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [probLabel, setProbLabel] = useState("combined");
  const [follow, setFollow] = useState(true);
  const stopStream = useRef<null | (() => void)>(null);
  const [queuePos, setQueuePos] = useState<number | null>(null);     // 0 = running, n = n jobs ahead
  useEffect(() => {
    if (!busy || !aid) { setQueuePos(null); return; }
    const tick = () => api.queue().then((q) => {
      if (q.running === aid) setQueuePos(0);
      else { const i = q.waiting.indexOf(aid); setQueuePos(i >= 0 ? i + 1 : null); }
    }).catch(() => {});
    tick();
    const h = setInterval(tick, 3000);
    return () => clearInterval(h);
  }, [busy, aid]);

  const refreshList = useCallback(() => api.list().then(setAnalyses).catch(() => {}), []);
  useEffect(() => {
    api.health().then(setHealth).catch((e) => toast.error(`Backend unreachable: ${e.message}`));
    api.config().then((c) => setStages(c.stages)).catch(() => {});
    api.sources().then(setSources).catch(() => {});
    refreshList();
  }, [refreshList]);

  const load = useCallback((id: string, goTo?: Tab) => {
    api.layers(id).then((d) => {
      setData(d);
      setEvents(d.analysis?.events ?? []);
      setSelected(d.candidates?.candidates?.[0] ?? null);
      setChecked(new Set(d.selected?.selected_component_ids ?? []));
      if (goTo) setTab(goTo);
      else setTab(d.candidates ? "candidates" : d.triage ? "triage" : "search");
    }).catch((e) => toast.error(e.message));
  }, []);

  const follow_ = (id: string, since: number, goTo: Tab) => {
    setBusy(true);
    stopStream.current?.();
    stopStream.current = api.events(id, since, (e) => setEvents((xs) => [...xs, e]),
      (d) => {
        setBusy(false); refreshList(); load(id, d.status === "COMPLETED" ? goTo : undefined);
        if (d.status === "FAILED") toast.error(d.error?.message ?? "Analysis failed");
        else toast.success(d.status === "AWAITING_SLICK_SELECTION" ? "Detection complete — review the triage" : `Analysis ${d.status.toLowerCase()}`);
      },
      () => { setBusy(false); toast.error("Lost the progress stream — reopen the analysis from the list."); });
  };

  const onSearch = (start: string, end: string) => {
    if (!aoi) return;
    setSearching(true);
    api.scenes(aoi, start, end).then((s) => { setScenes(s); setSceneId(s[0]?.id ?? null);
      if (!s.length) toast.message("No Sentinel-1 IW scenes for this area and period."); })
      .catch((e) => toast.error(e.message)).finally(() => setSearching(false));
  };
  const onDetect = (res: number) => {
    if (!sceneId || !aoi) return;
    setData(null); setEvents([]); setSelected(null); setChecked(new Set());
    api.detect(sceneId, aoi, res).then(({ analysis_id }) => { setAid(analysis_id); follow_(analysis_id, 0, "triage"); })
      .catch((e) => toast.error(e.message));
  };
  const onUpload = (f: FormData) => {
    setData(null); setEvents([]);
    api.upload(f).then(({ analysis_id }) => { setAid(analysis_id); follow_(analysis_id, 0, "triage"); }).catch((e) => toast.error(e.message));
  };
  const onInvestigate = () => {
    if (!aid) return;
    const since = events.length;
    api.investigate(aid, [...checked]).then(() => { setTab("investigation"); follow_(aid, since, "candidates"); })
      .catch((e) => toast.error(e.message));
  };
  const openAnalysis = (id: string) => { setAid(id); stopStream.current?.(); setBusy(false); load(id); };

  const toggle = (id: string) => setChecked((s) => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; });

  // ---- unified timeline (hindcast ascending, then forecast) ----------------------------------------
  const obs = data?.selected?.timestamp ? new Date(data.selected.timestamp) : data?.spill?.timestamp ? new Date(data.spill.timestamp) : null;
  const timeline = useMemo(() => {
    const out: TimeCursor[] = [];
    const b = data?.backward_particles;
    if (b) for (let i = b.times.length - 1; i >= 0; i--) out.push({ time: new Date(b.times[i]), kind: "backward", frame: i });
    const f = data?.forward_particles;
    if (f) f.times.forEach((t, i) => { if (i > 0) out.push({ time: new Date(t), kind: "forward", frame: i }); });
    return out;
  }, [data]);
  useEffect(() => { setIdx(0); setPlaying(false); }, [timeline]);
  useEffect(() => {
    if (!playing || !timeline.length) return;
    const h = setInterval(() => setIdx((i) => (i + 1) % timeline.length), 300);
    return () => clearInterval(h);
  }, [playing, timeline]);
  const cursor = timeline[idx] ?? null;
  const probLabels = useMemo(() => {
    const s = new Set<string>();
    data?.source_probability?.features.forEach((f) => f.properties.kind === "probability_cell" && s.add(f.properties.map));
    return ["combined", ...[...s].filter((x) => x !== "combined").sort((a, b) => parseFloat(a.slice(2)) - parseFloat(b.slice(2)))];
  }, [data]);
  const effProb = useMemo(() => {
    if (!follow || !cursor || !obs || cursor.kind !== "backward") return probLabel;
    const h = (obs.getTime() - cursor.time.getTime()) / 3600e3;
    const offs = probLabels.filter((l) => l !== "combined").map((l) => ({ l, h: parseFloat(l.slice(2)) }));
    return offs.length ? offs.reduce((a, b) => (Math.abs(b.h - h) < Math.abs(a.h - h) ? b : a)).l : probLabel;
  }, [follow, cursor, obs, probLabel, probLabels]);

  const selectCandidate = (c: Candidate) => {
    setSelected(c); setTab("evidence");
    const t = c.features?.best_match_time ? Date.parse(c.features.best_match_time) : null;
    if (t && timeline.length) {
      let best = 0;
      timeline.forEach((x, i) => { if (Math.abs(x.time.getTime() - t) < Math.abs(timeline[best].time.getTime() - t)) best = i; });
      setIdx(best); setPlaying(false);
    }
  };
  const stepDone = (k: Tab) => ({ search: !!data, triage: !!data?.triage, investigation: !!data?.drift,
    candidates: !!data?.candidates, evidence: !!selected }[k]);
  const warnings: string[] = data?.analysis?.warnings ?? [];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Toaster theme="dark" position="bottom-right" richColors />
      {/* ---------------- top bar ---------------- */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-4">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary"><Waves className="size-4.5" /></div>
          <div className="leading-tight"><div className="text-sm font-semibold">Oil Spill Investigation</div>
            <div className="text-[11px] text-muted-foreground">SIH26143 · detect → hindcast → correlate → explain</div></div>
        </div>
        <nav className="mx-auto hidden items-center gap-1 lg:flex">
          {STEPS.map((s, i) => (
            <button key={s.key} onClick={() => setTab(s.key)}
              className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors",
                tab === s.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <span className={cn("grid size-4.5 place-items-center rounded-full border text-[10px]",
                stepDone(s.key) && "border-emerald-500/60 bg-emerald-500/20 text-emerald-300")}>{i + 1}</span>{s.label}
            </button>))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <select className="h-8 max-w-56 rounded-lg border bg-transparent px-2 text-xs" value={aid ?? ""}
            onChange={(e) => e.target.value && openAnalysis(e.target.value)}>
            <option value="">Open investigation…</option>
            {analyses.map((a) => <option key={a.analysis_id} value={a.analysis_id}>{a.analysis_id.replace("SPILL_", "")} · {a.status}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => setSourcesOpen(true)}><Database />Data sources</Button>
          {data?.candidates && <Button size="sm" variant="outline" render={<a href={data.report_html_url} target="_blank" />}><FileText />Report</Button>}
          {health && <Badge variant="outline" className="text-[10px]">GPU {health.cuda ? "✓" : "✗"} · {health.mode?.toUpperCase()}</Badge>}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- workspace ---------------- */}
        <aside className="flex w-[340px] shrink-0 flex-col border-r bg-sidebar xl:w-[440px]">
          {data && <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-[11px] text-muted-foreground">
            <span>SAR</span><Prov p={data.acquisition?.provenance ?? data.scene?.georef?.provenance} />
            <span className="ml-1">Forcing</span><Prov p={data.drift?.forcing?.provenance} />
            <span className="ml-1">AIS</span><Prov p={data.candidates?.ais?.provider?.provenance} />
          </div>}
          {warnings.length > 0 && <div className="border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">{warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0">
            <TabsList variant="line" className="w-full justify-start border-b px-2 lg:hidden">
              {STEPS.map((s) => <TabsTrigger key={s.key} value={s.key} className="text-xs">{s.label}</TabsTrigger>)}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TabsContent value="search">
                <SearchPanel aoi={aoi} setAoi={setAoi} drawing={drawing} setDrawing={setDrawing} scenes={scenes} sceneId={sceneId}
                  setSceneId={setSceneId} busy={busy} onSearch={onSearch} searching={searching} onDetect={onDetect} onUpload={onUpload} />
              </TabsContent>
              <TabsContent value="triage" className="grid gap-3">
                {data ? <TriagePanel d={data} checked={checked} toggle={toggle} busy={busy} onInvestigate={onInvestigate}
                  onFocus={(r) => setFocusRow(r)} /> : <p className="text-xs text-muted-foreground">No detection loaded.</p>}
                <SlickDetail r={focusRow} />
              </TabsContent>
              <TabsContent value="investigation">{data ? <InvestigationPanel d={data} /> : null}</TabsContent>
              <TabsContent value="candidates">{data ? <CandidatesPanel d={data} selected={selected} select={selectCandidate} /> : null}</TabsContent>
              <TabsContent value="evidence"><EvidencePanel c={selected} /></TabsContent>
            </div>
          </Tabs>
          <p className="border-t px-3 py-2 text-[10px] leading-snug text-muted-foreground">Investigative decision support. Rankings reflect evidence
            correlation under stated assumptions and do not establish that any vessel caused a spill.</p>
        </aside>

        {/* ---------------- map ---------------- */}
        <main className="relative min-w-0 flex-1">
          <MapView data={data} visible={visible} cursor={cursor} probLabel={effProb} selected={selected}
            onSelectMmsi={(m) => { const c = data?.candidates?.candidates?.find((x: Candidate) => x.vessel.mmsi === m); if (c) selectCandidate(c); }}
            aoi={aoi} drawing={drawing} onAoi={(b) => { setAoi(b); setDrawing(false); }}
            scenes={tab === "search" ? scenes : []} sceneId={sceneId} onSceneClick={setSceneId}
            checked={checked} onToggleComponent={toggle} focus={focusRow ? focusRow.centroid : null} fitSignal={fitSignal} />
          <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
            <div className="pointer-events-auto grid gap-2">
              {busy && queuePos !== null && queuePos > 0 && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Queued — {queuePos} analysis job{queuePos === 1 ? "" : "s"} ahead (one job runs at a time on this machine)</div>}
              {events.length > 0 && <ProgressCard events={events} stages={stages} busy={busy} />}
            </div>
            <div className="pointer-events-auto mr-12 grid justify-items-end gap-2">
              <div className="flex gap-2">
                {data && <Button size="sm" variant="secondary" onClick={() => setFitSignal((x) => x + 1)}><Maximize2 />Zoom to scene</Button>}
                <Button size="sm" variant="secondary" onClick={() => setLayersOpen(!layersOpen)}><LayersIcon />Layers</Button>
              </div>
              {layersOpen && <LayerMenu visible={visible} set={(k, v) => setVisible((s) => ({ ...s, [k]: v }))} probLabel={probLabel}
                probLabels={probLabels} setProbLabel={setProbLabel} follow={follow} setFollow={setFollow} />}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border bg-card/90 p-2.5 text-[11px] backdrop-blur">
            {[["#ff5a1f", "Oil-likely"], ["#facc15", "Uncertain"], ["#4ade80", "Look-alike likely"], ["#67e8f9", "Hindcast particles"],
              ["#c084fc", "Forecast / affected area"], ["#ef4444", "50 % source region"], ["#22d3ee", "Selected vessel"]].map(([c, l]) =>
              <div key={l} className="flex items-center gap-2"><span className="h-2 w-3.5 rounded-sm" style={{ background: c }} />{l}</div>)}
          </div>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <Timeline times={timeline} idx={idx} setIdx={setIdx} playing={playing} setPlaying={setPlaying} obs={obs} /></div>
          {drawing && <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground">
            Drag a rectangle over water to set the area of interest</div>}
        </main>
      </div>
      <SourcesSheet open={sourcesOpen} setOpen={setSourcesOpen} sources={sources} />
    </div>
  );
}
