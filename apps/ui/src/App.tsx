import { PROVIDER_MODELS } from '@verdant/llm';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Provider, type RunPayload, type RunState } from './lib/api';

type WsEnvelope = {
  type: string;
  runId?: string;
  event?: {
    type: 'log' | 'state' | 'decision' | 'artifact' | 'status';
    ts: string;
    level?: 'info' | 'warn' | 'error' | 'debug';
    message?: string;
    step?: number;
    state?: unknown;
    decision?: unknown;
    artifact?: { type: 'screenshot'; path: string };
    status?: string;
  };
};

type EventLog = {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  step?: number;
  message: string;
};

const defaultRuleset = `{
  "singleSelect": "first",
  "multiSelect": { "mode": "first_n", "n": 2 },
  "text": {
    "default": "AUTO_TEST_RESPONSE",
    "byKeyword": {
      "email": "test.user@example.com",
      "name": "Test User"
    }
  }
}`;

const toArtifactUrl = (absolutePath: string) => {
  const normalized = absolutePath.replaceAll('\\', '/');
  const marker = '/artifacts/';
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(index) : normalized;
};

function App() {
  const [surveyUrl, setSurveyUrl] = useState('https://app.greenspacehealth.com/sample/inq');
  const [sheetUrl, setSheetUrl] = useState('');
  const [csvContent, setCsvContent] = useState('');
  const [instructions, setInstructions] = useState('Answer all questions as a realistic first-time customer.');
  const [strategy, setStrategy] = useState<RunPayload['strategy']>('first');
  const [rulesetJson, setRulesetJson] = useState(defaultRuleset);
  const [speedMode, setSpeedMode] = useState<RunPayload['speedMode']>('fast');
  const [captureScreenshots, setCaptureScreenshots] = useState(false);
  const [recordVideo, setRecordVideo] = useState(false);
  const [completeSurvey, setCompleteSurvey] = useState(true);

  // Batch Mode State
  const [iterations, setIterations] = useState(1);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchQueue, setBatchQueue] = useState<RunPayload[]>([]);
  const [batchResults, setBatchResults] = useState<{ id: string; url: string; status: string }[]>([]);
  const [processingRunId, setProcessingRunId] = useState<string | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showDataOptions, setShowDataOptions] = useState(false);
  const [verbose, setVerbose] = useState(true);
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState(PROVIDER_MODELS.openai[0]);
  const [apiKey, setApiKey] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [sheetPreview, setSheetPreview] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState('');
  const [runState, setRunState] = useState<RunState | null>(null);
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [decisions, setDecisions] = useState<Array<{ step: number; payload: unknown }>>([]);
  const [states, setStates] = useState<Array<{ step: number; payload: unknown }>>([]);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  const statusTone = useMemo(() => {
    const status = runState?.status ?? 'idle';
    if (status === 'success') return 'bg-gs-teal/10 text-gs-teal';
    if (status === 'error') return 'bg-ember/10 text-ember';
    if (status === 'blocked') return 'bg-gs-dark/10 text-gs-dark';
    if (status === 'running') return 'bg-gs-blue/20 text-gs-dark';
    return 'bg-black/5 text-black/70';
  }, [runState?.status]);

  const loadKeys = async () => {
    try {
      const data = await api.listKeys();
      setKeys(data.providers ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load key metadata.');
    }
  };

  useEffect(() => {
    void loadKeys();

    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runId) return;

    const timer = window.setInterval(async () => {
      try {
        const next = (await api.getRun(runId)) as RunState;
        setRunState(next);

        if (next.status === 'success' || next.status === 'blocked' || next.status === 'error') {
          setIsRunning(false);
        }
      } catch {
        // Ignore transient polling errors.
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [runId]);

  const connectWebsocket = (nextRunId: string) => {
    wsRef.current?.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', runId: nextRunId }));
    });

    socket.addEventListener('message', (messageEvent) => {
      const parsed = JSON.parse(messageEvent.data as string) as WsEnvelope;

      if (parsed.type !== 'run_event' || !parsed.event) {
        return;
      }

      const event = parsed.event;

      if (event.type === 'log' && event.message && event.level) {
        setLogs((prev) => [
          {
            ts: event.ts,
            level: event.level!,
            message: event.message!,
            ...(event.step !== undefined ? { step: event.step } : {})
          },
          ...prev
        ].slice(0, 400));
      }

      if (event.type === 'decision' && typeof event.step === 'number') {
        const payload = event.decision;
        setDecisions((prev) => [{ step: event.step!, payload }, ...prev]);
      }

      if (event.type === 'state' && typeof event.step === 'number') {
        const payload = event.state;
        setStates((prev) => [{ step: event.step!, payload }, ...prev]);
      }

      if (event.type === 'artifact' && event.artifact?.path) {
        setArtifacts((prev) => [toArtifactUrl(event.artifact!.path), ...prev]);
      }

      if (event.type === 'status' && event.status) {
        // We can update local run state status if needed, or just the message
        // For now, let's track the message for the UI
        if (event.message) setStatusMessage(event.message);
      }
    });

    wsRef.current = socket;
  };

  const onCsvFile = async (file: File | null) => {
    if (!file) {
      setCsvContent('');
      return;
    }

    const text = await file.text();
    setCsvContent(text);
  };

  const onSaveKey = async () => {
    setError('');
    try {
      await api.saveKey(provider, apiKey);
      setApiKey('');
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to store API key.');
    }
  };

  const onResolveSheet = async () => {
    setError('');

    try {
      const data = await api.resolveSheet({
        ...(sheetUrl.trim() ? { sheetUrl: sheetUrl.trim() } : {}),
        ...(csvContent.trim() ? { csvContent: csvContent.trim() } : {})
      });
      setSheetPreview(data.data ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse sheet input.');
    }
  };

  const onRun = async () => {
    // 1. Parse URLs
    const urls = surveyUrl.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) return;

    // 2. Generate Payload Configuration (common)
    // 2. Generate Payload Configuration (common)
    const basePayload = {
      runId: '', // placeholder
      instructions,
      strategy,
      speedMode,
      captureScreenshots,
      recordVideo,
      completeSurvey,
      verbose,
      provider,
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(strategy === 'ruleset' ? { ruleset: JSON.parse(rulesetJson || '{}') } : {}),
      ...(Object.keys(sheetPreview).length > 0 ? { sheetData: sheetPreview } : {}),
    } as RunPayload;

    // 3. Create Batch Queue
    const queue: RunPayload[] = [];
    for (const url of urls) {
      for (let i = 0; i < iterations; i++) {
        queue.push({
          ...basePayload,
          runId: crypto.randomUUID(),
          surveyUrl: url
        });
      }
    }

    if (queue.length === 0) return;

    // 4. Reset Batch State
    setBatchResults([]);
    setIsBatchMode(queue.length > 1);
    setBatchQueue(queue); // Full queue initially

    // 5. Start First Run
    const firstRun = queue[0];
    if (!firstRun) return;

    // Remove first from queued state (it's now active)
    setBatchQueue(queue.slice(1));
    setProcessingRunId(firstRun.runId ?? null);

    // Clear logs/artifacts for fresh start visual
    setLogs([]);
    setDecisions([]);
    setArtifacts([]);
    setStates([]);
    setStates([]);
    setRunState(null);
    setStatusMessage('Starting...');

    try {
      const run = await api.startRun(firstRun);
      setRunId(run.runId as string);
      connectWebsocket(run.runId as string);
      setIsRunning(true);
    } catch (error) {
      console.error('Failed to start run:', error);
      setIsRunning(false);
    }
  };

  // Batch Processor Effect
  useEffect(() => {
    if (!isBatchMode || !processingRunId || !runState) return;

    // Check if current run finished
    if (runState.runId === processingRunId && (runState.status === 'success' || runState.status === 'blocked' || runState.status === 'error')) {

      // Record Result
      setBatchResults(prev => [...prev, {
        id: runState.runId,
        url: runState.surveyUrl || 'Unknown',
        status: runState.status
      }]);

      setProcessingRunId(null); // Mark current as done processing

      // Trigger Next
      if (batchQueue.length > 0) {
        const nextRun = batchQueue[0];
        if (nextRun) {
          setBatchQueue(prev => prev.slice(1));

          // Small delay to allow UI to settle?
          setTimeout(() => {
            setProcessingRunId(nextRun.runId ?? null);
            setLogs([]);
            setDecisions([]);
            setArtifacts([]);
            setStates([]);
            setRunState(null);
            setStatusMessage('Starting...');

            void api.startRun(nextRun)
              .then(run => {
                setRunId(run.runId as string);
                connectWebsocket(run.runId as string);
              });
          }, 1000);
        }
      } else {
        // Batch Complete
        setIsBatchMode(false);
        setIsRunning(false);
      }
    }
  }, [runState, processingRunId, isBatchMode, batchQueue]);

  // Dark Mode
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('verdant-theme') === 'dark' ||
        (!localStorage.getItem('verdant-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('verdant-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('verdant-theme', 'light');
    }
  }, [darkMode]);

  // ... (keep existing effects) ...

  const LogoIcon = () => (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-verdant-DEFAULT dark:text-white">
      <path d="M20 0C8.9543 0 0 8.9543 0 20C0 31.0457 8.9543 40 20 40C31.0457 40 40 31.0457 40 20C40 8.9543 31.0457 0 20 0ZM20 36C11.1634 36 4 28.8366 4 20C4 11.1634 11.1634 4 20 4C28.8366 4 36 11.1634 36 20C36 28.8366 28.8366 36 20 36Z" fill="currentColor" opacity="0.1" />
      <path d="M13 26L20 12L27 26H23L20 18L17 26H13Z" fill="currentColor" />
      <path d="M20 28C20 28 16 26 13 26C16 26 18 24 20 20C22 24 24 26 27 26C24 26 20 28 20 28Z" fill="currentColor" fillOpacity="0.5" />
    </svg>
  );

  return (
    <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'bg-verdant-dark text-verdant-text-light' : 'bg-verdant-light text-verdant-text'}`}>
      <header className="sticky top-0 z-50 border-b border-black/5 bg-white/80 px-6 py-4 backdrop-blur-md dark:border-white/10 dark:bg-verdant-dark/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-4">
            <LogoIcon />
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-verdant-DEFAULT dark:text-white">VERDANT</h1>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-verdant-accent dark:text-verdant-accent/80">LLM Survey Validator</span>
                <span className="hidden text-[10px] text-black/40 dark:text-white/30 sm:inline-block">• Local-first QA Runner</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className={`status-pill ${statusTone} text-xs font-bold uppercase tracking-wide px-3 py-1 rounded-full`}>
              {runState?.status ?? 'idle'}
            </div>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="rounded-full p-2 text-black/60 transition hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              title="Toggle Dark Mode"
            >
              {darkMode ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {error && (
          <div className="panel mb-6 border-ember/40 bg-ember/10 p-4 text-sm text-ember dark:text-red-300">
            <strong className="mr-2">Error:</strong>
            {error}
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[400px_1fr]">
          <section className="panel space-y-6 border-black/5 bg-white p-6 shadow-panel dark:border-white/10 dark:bg-white/5 dark:shadow-panel-dark">
            <h2 className="text-lg font-semibold dark:text-white">Run Configuration</h2>

            <div className="grid gap-3 sm:grid-cols-4">
              <label className="block text-sm sm:col-span-3 dark:text-white/80">
                Survey URL(s) - one per line
                <textarea
                  className="field mt-1 min-h-[5rem] whitespace-pre dark:bg-black/20 dark:border-white/10 dark:text-white"
                  value={surveyUrl}
                  onChange={(event) => setSurveyUrl(event.target.value)}
                  placeholder="https://..."
                />
              </label>
              <label className="block text-sm dark:text-white/80">
                Runs per URL
                <input
                  type="number"
                  min="1"
                  max="100"
                  className="field mt-1 dark:bg-black/20 dark:border-white/10 dark:text-white"
                  value={iterations}
                  onChange={(e) => setIterations(parseInt(e.target.value) || 1)}
                />
              </label>
            </div>

            <button
              className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-medium transition hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              onClick={() => setShowSettings(true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              Configure Provider & API Keys
            </button>

            <div className="rounded-xl border border-black/5 bg-white/50 p-3 dark:border-white/10 dark:bg-white/5">
              <button
                className="flex w-full items-center justify-between text-sm font-medium text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
                onClick={() => setShowDataOptions(!showDataOptions)}
              >
                <span>Load Data from Sheet/CSV (Optional)</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${showDataOptions ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>

              {showDataOptions && (
                <div className="mt-3 space-y-4 pt-2">
                  <label className="block text-sm dark:text-white/80">
                    Google Sheet URL
                    <input className="field mt-1 dark:bg-black/20 dark:border-white/10 dark:text-white" value={sheetUrl} onChange={(event) => setSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." />
                  </label>

                  <label className="block text-sm dark:text-white/80">
                    CSV Fallback
                    <input className="field mt-1 dark:bg-black/20 dark:border-white/10 dark:text-white" type="file" accept=".csv,text/csv" onChange={(event) => void onCsvFile(event.target.files?.[0] ?? null)} />
                  </label>

                  <div className="flex items-center gap-2">
                    <button className="rounded-xl border border-black/15 px-3 py-2 text-sm dark:border-white/20 dark:text-white" type="button" onClick={onResolveSheet}>
                      Preview Sheet Data
                    </button>
                    <span className="mono text-xs text-black/55 dark:text-white/40">{Object.keys(sheetPreview).length} key/value pairs</span>
                  </div>
                </div>
              )}
            </div>

            <label className="block text-sm dark:text-white/80">
              Instructions
              <textarea className="field mt-1 min-h-24 dark:bg-black/20 dark:border-white/10 dark:text-white" value={instructions} onChange={(event) => setInstructions(event.target.value)} />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm dark:text-white/80 whitespace-nowrap">
                Answer Strategy
                <select className="field mt-1 dark:bg-black/20 dark:border-white/10 dark:text-white" value={strategy} onChange={(event) => setStrategy(event.target.value as RunPayload['strategy'])}>
                  <option value="first">First</option>
                  <option value="last">Last</option>
                  <option value="random">Random (seeded)</option>
                  <option value="ruleset">Ruleset</option>
                </select>
              </label>
            </div>

            {strategy === 'ruleset' && (
              <label className="block text-sm dark:text-white/80">
                Ruleset JSON
                <textarea className="field mono mt-1 min-h-40 text-xs dark:bg-black/20 dark:border-white/10 dark:text-white" value={rulesetJson} onChange={(event) => setRulesetJson(event.target.value)} />
              </label>
            )}

            <div className="flex flex-wrap gap-3">
              <label className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm transition hover:border-gs-teal/30 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap">
                <input type="checkbox" className="accent-gs-teal" checked={captureScreenshots} onChange={(event) => setCaptureScreenshots(event.target.checked)} />
                Capture screenshots
              </label>
              <label className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm transition hover:border-gs-teal/30 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap">
                <input type="checkbox" className="accent-gs-teal" checked={recordVideo} onChange={(event) => setRecordVideo(event.target.checked)} />
                Record Video
              </label>
              <label className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm transition hover:border-gs-teal/30 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap">
                <input type="checkbox" className="accent-gs-teal" checked={completeSurvey} onChange={(event) => setCompleteSurvey(event.target.checked)} />
                Complete survey
              </label>
              <label className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm transition hover:border-gs-teal/30 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 whitespace-nowrap">
                <input type="checkbox" className="accent-gs-teal" checked={verbose} onChange={(event) => setVerbose(event.target.checked)} />
                Verbose Logging
              </label>
            </div>

            <button
              className="w-full rounded-xl bg-gs-blue px-4 py-3 text-sm font-bold text-gs-dark shadow-sm transition hover:bg-[#8bb4c5] disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={isRunning || !surveyUrl.trim() || !instructions.trim()}
              onClick={() => void onRun()}
            >
              {isRunning ? 'Running...' : 'Run Survey'}
            </button>
          </section>

          <section className="space-y-6">
            {/* Batch Progress Report */}
            {batchResults.length > 0 && (
              <div className="panel p-5 mb-6 border-l-4 border-verdant-accent bg-white dark:bg-white/5 shadow-panel dark:shadow-panel-dark">
                <h2 className="mb-3 text-lg font-semibold flex justify-between dark:text-white">
                  <span>Batch Progress</span>
                  <span className="text-sm font-normal text-black/60 dark:text-white/60">
                    {batchResults.length} / {batchResults.length + batchQueue.length + (processingRunId ? 1 : 0)} runs
                  </span>
                </h2>
                <div className="max-h-40 overflow-y-auto space-y-1 text-sm">
                  {batchResults.map((res, i) => (
                    <div key={i} className="flex items-center justify-between border-b border-black/5 pb-1 last:border-0 dark:border-white/10">
                      <span className="truncate max-w-[70%] text-xs mono dark:text-white/80">{res.url}</span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${res.status === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' :
                        res.status === 'blocked' ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300' :
                          'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                        }`}>
                        {res.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                  {isBatchMode && processingRunId && (
                    <div className="flex items-center justify-between pt-1 animate-pulse opacity-60 dark:text-white/70">
                      <span className="text-xs">Running next...</span>
                      <span className="text-xs bg-gray-100 px-2 py-0.5 rounded dark:bg-white/10">PENDING</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="panel p-5 bg-white shadow-panel dark:bg-white/5 dark:shadow-panel-dark">
              <h2 className="mb-3 text-lg font-semibold dark:text-white">Run Report</h2>
              <div className="space-y-2 text-sm dark:text-white/80">
                <p>
                  <span className="font-semibold">Run ID:</span>{' '}
                  <span className="mono text-xs">{runId || '—'}</span>
                </p>
                <p>
                  <span className="font-semibold">Status:</span>{' '}
                  <span className={`font-bold ${statusTone.replace('bg-', 'text-').split(' ')[0]}`}>
                    {(runState?.status ?? (isRunning ? 'running' : 'idle')).toUpperCase()}
                  </span>
                </p>
                <p>
                  <span className="font-semibold">Message:</span> {statusMessage || runState?.report?.message || 'Waiting for run...'}
                </p>
                <p>
                  <span className="font-semibold">Steps:</span> {states.length > 0 ? states.length : (runState?.report?.steps.length ?? 0)}
                </p>
              </div>
            </div>

            <div className="panel p-5 bg-white shadow-panel dark:bg-white/5 dark:shadow-panel-dark">
              <h2 className="mb-3 text-lg font-semibold dark:text-white">Decisions</h2>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {decisions.map((entry, index) => (
                  <pre key={`${entry.step}-${index}`} className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-black/5 p-2 text-xs dark:bg-black/40 dark:text-white/90">
                    Step {entry.step}{'\n'}{JSON.stringify(entry.payload, null, 2)}
                  </pre>
                ))}
                {decisions.length === 0 && <p className="text-sm text-black/50 dark:text-white/40">No decisions yet.</p>}
              </div>
            </div>
          </section>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <section className="panel flex flex-col p-5 bg-white shadow-panel h-[32rem] overflow-hidden dark:bg-white/5 dark:shadow-panel-dark">
            <div className="mb-3 flex items-center justify-between flex-shrink-0">
              <h2 className="text-lg font-semibold dark:text-white">Live Logs</h2>
              <button
                className="rounded-lg border border-black/10 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/10"
                onClick={() => {
                  const text = logs.map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()}: ${l.message}`).join('\n');
                  void navigator.clipboard.writeText(text);
                }}
              >
                Copy Logs
              </button>
            </div>
            <div className="mono flex-1 space-y-2 overflow-y-auto text-xs pr-2">
              {logs.map((entry, index) => (
                <div key={`${entry.ts}-${index}`} className="rounded-lg border border-black/10 bg-gs-gray/50 p-2 dark:border-white/5 dark:bg-white/5">
                  <span className="mr-2 text-black/55 dark:text-white/40">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className={entry.level === 'error' ? 'text-ember dark:text-red-400' : entry.level === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-verdant-accent dark:text-teal-400'}>
                    {entry.level.toUpperCase()}
                  </span>
                  {typeof entry.step === 'number' && <span className="ml-2 text-black/55 dark:text-white/40">step {entry.step}</span>}
                  <div className="mt-1 whitespace-pre-wrap break-all dark:text-white/90">{entry.message}</div>
                </div>
              ))}
              {logs.length === 0 && <p className="text-sm text-black/50 dark:text-white/40">No logs yet.</p>}
            </div>
          </section>

          <section className="panel p-5 bg-white shadow-panel dark:bg-white/5 dark:shadow-panel-dark">
            <h2 className="mb-3 text-lg font-semibold dark:text-white">Screenshots</h2>
            <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
              {artifacts.map((artifact, index) => (
                <a key={`${artifact}-${index}`} href={artifact} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                  <img src={artifact} alt={`run artifact ${index + 1}`} className="h-24 w-full object-cover" />
                </a>
              ))}
              {artifacts.length === 0 && <p className="col-span-2 text-sm text-black/50 dark:text-white/40">No screenshots yet.</p>}
            </div>


            {runState?.report?.video && (
              <>
                <h2 className="mb-3 mt-6 text-lg font-semibold">Video Recording</h2>
                <video
                  className="w-full rounded-xl border border-black/10 bg-black"
                  controls
                  src={`/artifacts/runs/${runState.runId}/${runState.report.video}`}
                />
              </>
            )}
          </section>
        </div >

        <section className="panel mt-6 p-5 bg-white shadow-panel dark:bg-white/5 dark:shadow-panel-dark">
          <h2 className="mb-3 text-lg font-semibold dark:text-white">Extracted Step States</h2>
          <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
            {states.map((entry, index) => (
              <pre key={`${entry.step}-${index}`} className="rounded-xl bg-black/5 p-2 text-xs">
                Step {entry.step}\n{JSON.stringify(entry.payload, null, 2)}
              </pre>
            ))}
            {states.length === 0 && <p className="text-sm text-black/50 dark:text-white/40">No state snapshots yet.</p>}
          </div>
        </section>
      </main >

      {
        showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-verdant-dark dark:border dark:border-white/10 dark:shadow-2xl">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-bold text-verdant-DEFAULT dark:text-white">Provider Settings</h2>
                <button onClick={() => setShowSettings(false)} className="rounded-full p-1 text-black/40 transition hover:bg-black/5 hover:text-black dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>

              <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium dark:text-white/90">
                    Provider
                    <select
                      className="field mt-1.5 w-full dark:bg-black/20 dark:border-white/10 dark:text-white"
                      value={provider}
                      onChange={(event) => {
                        const nextProvider = event.target.value as Provider;
                        setProvider(nextProvider);
                        setModel(PROVIDER_MODELS[nextProvider][0]);
                      }}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="google">Google Gemini</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="groq">Groq</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="xai">xAI</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium dark:text-white/90">
                    Model
                    <select className="field mt-1.5 w-full dark:bg-black/20 dark:border-white/10 dark:text-white" value={model} onChange={(event) => setModel(event.target.value)}>
                      {PROVIDER_MODELS[provider].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block text-sm font-medium dark:text-white/90">
                  <span className="flex items-center gap-2">
                    API Key
                    <span className="text-xs font-normal text-black/50 dark:text-white/40">(ephemeral unless saved)</span>
                  </span>
                  <input
                    className="field mt-1.5 w-full dark:bg-black/20 dark:border-white/10 dark:text-white"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={keys[provider] ? `Saved key: ${keys[provider].substring(0, 8)}...` : 'sk-...'}
                  />
                </label>

                <div className="flex flex-wrap gap-3">
                  <button
                    className="flex items-center gap-2 rounded-xl bg-verdant-DEFAULT px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-verdant-dark focus:ring-2 focus:ring-verdant-DEFAULT/20 dark:bg-verdant-accent dark:text-verdant-dark dark:hover:bg-white"
                    type="button"
                    onClick={onSaveKey}
                  >
                    Save Key
                  </button>
                  <button
                    className="flex items-center gap-2 rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm font-medium text-black/70 transition hover:bg-black/5 hover:text-black dark:border-white/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10 dark:hover:text-white"
                    type="button"
                    onClick={() => {
                      setApiKey('');
                      void loadKeys();
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>
                    Refresh
                  </button>
                </div>

                <div className="mt-8 flex justify-end border-t border-black/5 pt-5 dark:border-white/10">
                  <button
                    className="min-w-[100px] rounded-xl bg-black px-5 py-2.5 text-sm font-bold text-white shadow-lg transition hover:bg-black/80 dark:bg-white dark:text-verdant-dark dark:hover:bg-white/90"
                    onClick={() => setShowSettings(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }</div>
  );
}

export default App;
