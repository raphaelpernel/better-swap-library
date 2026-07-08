import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Field, Input, Progress, RadioGroup, Select, Tabs } from "./components";
import type {
  MainToUiMessage,
  PluginConfig,
  SwapCategory,
  SwapCounts,
  SwapDirection,
  SwapScope,
  TargetLibrary,
  UiToMainMessage,
  UnmatchedEntry,
} from "../shared/types";

function send(message: UiToMainMessage) {
  parent.postMessage({ pluginMessage: message }, "*");
}

const PHASE_LABEL: Record<SwapCategory, string> = {
  components: "Components",
  variables: "Variables",
  textStyles: "Text styles",
  effectStyles: "Effects",
};

export function App() {
  const [tab, setTab] = useState<"swap" | "config">("swap");
  const [config, setConfig] = useState<PluginConfig | null>(null);
  const [enabledVarLibs, setEnabledVarLibs] = useState<string[]>([]);
  const [hasSelection, setHasSelection] = useState(false);

  const [tokenInput, setTokenInput] = useState("");

  const [baseUrl, setBaseUrl] = useState("");
  const [baseVarLib, setBaseVarLib] = useState("");
  const [baseError, setBaseError] = useState<string | null>(null);
  const [savingBase, setSavingBase] = useState(false);

  const [targetLabel, setTargetLabel] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [targetVarLib, setTargetVarLib] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [direction, setDirection] = useState<SwapDirection>("BaseToTarget");
  const [scope, setScope] = useState<SwapScope>("selection");
  const [scopeInfo, setScopeInfo] = useState<{ count: number; label: string } | null>(null);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<SwapCategory | null>(null);
  const [phaseDone, setPhaseDone] = useState(0);
  const [phaseTotal, setPhaseTotal] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [logs, setLogs] = useState<{ level: string; message: string }[]>([]);
  const [result, setResult] = useState<{ counts: SwapCounts; unmatched: UnmatchedEntry[]; elapsedMs: number } | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data.pluginMessage as MainToUiMessage | undefined;
      if (!msg) return;

      switch (msg.type) {
        case "init":
          setConfig(msg.config);
          setEnabledVarLibs(msg.enabledVariableLibraries);
          setHasSelection(msg.hasSelection);
          if (!selectedTargetId && msg.config.targets.length > 0) setSelectedTargetId(msg.config.targets[0].id);
          break;
        case "base-set":
          setConfig((c) => (c ? { ...c, base: msg.base } : c));
          setBaseUrl("");
          setBaseVarLib("");
          setBaseError(null);
          setSavingBase(false);
          break;
        case "base-error":
          setBaseError(msg.message);
          setSavingBase(false);
          break;
        case "target-added":
          setConfig((c) => (c ? { ...c, targets: [...c.targets, msg.target] } : c));
          setTargetLabel("");
          setTargetUrl("");
          setTargetVarLib("");
          setTargetError(null);
          setSavingTarget(false);
          setSelectedTargetId(msg.target.id);
          break;
        case "target-deleted":
          setConfig((c) => (c ? { ...c, targets: c.targets.filter((t) => t.id !== msg.id) } : c));
          break;
        case "target-error":
          setTargetError(msg.message);
          setSavingTarget(false);
          break;
        case "token-saved":
          setConfig((c) => (c ? { ...c, hasToken: true } : c));
          setTokenInput("");
          break;
        case "scope-info":
          setScopeInfo({ count: msg.count, label: msg.label });
          break;
        case "progress":
          setPhase(msg.phase);
          setPhaseDone(msg.done);
          setPhaseTotal(msg.total);
          setElapsedMs(msg.elapsedMs);
          break;
        case "log":
          setLogs((l) => [...l.slice(-49), { level: msg.level, message: msg.message }]);
          break;
        case "done":
          setRunning(false);
          setResult({ counts: msg.counts, unmatched: msg.unmatched, elapsedMs: msg.elapsedMs });
          setPhase(null);
          break;
        case "error":
          setRunning(false);
          setErrorMsg(msg.message);
          break;
      }
    };
    window.addEventListener("message", handler);
    send({ type: "ui-ready" });
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    send({ type: "get-scope-info", scope });
  }, [scope]);

  const selectedTarget = useMemo(
    () => config?.targets.find((t) => t.id === selectedTargetId) ?? null,
    [config, selectedTargetId],
  );

  function runSwap() {
    if (!selectedTargetId) return;
    setRunning(true);
    setResult(null);
    setErrorMsg(null);
    setLogs([]);
    setPhase(null);
    send({ type: "run-swap", targetId: selectedTargetId, direction, scope });
  }

  function setBase() {
    if (!baseUrl) {
      setBaseError("Enter the reference file URL.");
      return;
    }
    setSavingBase(true);
    setBaseError(null);
    send({ type: "set-base", fileUrl: baseUrl, variableLibraryName: baseVarLib || undefined });
  }

  function addTarget() {
    if (!targetUrl) {
      setTargetError("Enter the target file URL.");
      return;
    }
    setSavingTarget(true);
    setTargetError(null);
    send({
      type: "add-target",
      label: targetLabel,
      fileUrl: targetUrl,
      variableLibraryName: targetVarLib || undefined,
    });
  }

  if (!config) {
    return <div style={{ padding: 16, fontSize: 12 }}>Loading…</div>;
  }

  return (
    <div className="bsl-scroll">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "swap", label: "Swap" },
          { value: "config", label: "Configuration" },
        ]}
      />

      {tab === "config" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 12 }}>
          <Card title="Personal Access Token">
            <Field
              label="Figma token"
              help="Minimum scope file_content:read. Create once in Figma > Settings > Personal access tokens; stored locally (clientStorage), never sent anywhere except api.figma.com."
            >
              <div className="bsl-row-inline">
                <Input
                  type="password"
                  placeholder={config.hasToken ? "Token already saved" : "figd_…"}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={!tokenInput}
                  onClick={() => send({ type: "save-token", token: tokenInput })}
                >
                  Save
                </Button>
              </div>
            </Field>
            {config.hasToken && (
              <Button variant="destructive" onClick={() => send({ type: "clear-token" })}>
                Delete token
              </Button>
            )}
          </Card>

          <Card title="Reference library">
            {config.base ? (
              <>
                <div className="bsl-pair-item">
                  <span>
                    {config.base.fileName}
                    {config.base.variableLibraryName ? ` · variables: ${config.base.variableLibraryName}` : ""}
                  </span>
                  <Button variant="destructive" onClick={() => send({ type: "clear-base" })}>
                    ×
                  </Button>
                </div>
                <div className="bsl-help">
                  Always used as Library A (e.g. Mealz DS / Neutral). Change it here if needed.
                </div>
              </>
            ) : (
              <div className="bsl-help">No reference library set yet — this is the first thing to do.</div>
            )}
            <div className="bsl-row" style={{ marginTop: 8, borderTop: "1px solid hsl(var(--border))", paddingTop: 10 }}>
              <Field label="Reference file URL" help="The source file of your design system (e.g. Mealz DS / Neutral).">
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://www.figma.com/design/…" />
              </Field>
              <Field
                label="Associated variable library (optional)"
                help="Must be enabled in this file (Assets > Libraries panel) to show up here."
              >
                <Select value={baseVarLib} onChange={(e) => setBaseVarLib(e.target.value)}>
                  <option value="">— none —</option>
                  {enabledVarLibs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              {baseError && <div className="bsl-log-line-error">{baseError}</div>}
              <Button full disabled={savingBase || !config.hasToken} onClick={setBase}>
                {savingBase ? "Checking…" : config.base ? "Replace reference" : "Set as reference"}
              </Button>
              {!config.hasToken && <div className="bsl-help">Add a token above first.</div>}
            </div>
          </Card>

          <Card title="Target libraries (clients)">
            {config.targets.length === 0 && <div className="bsl-help">No target library configured yet.</div>}
            {config.targets.map((t: TargetLibrary) => (
              <div className="bsl-pair-item" key={t.id}>
                <span>
                  {t.label}
                  {t.variableLibraryName ? ` · variables: ${t.variableLibraryName}` : ""}
                </span>
                <Button variant="destructive" onClick={() => send({ type: "delete-target", id: t.id })}>
                  ×
                </Button>
              </div>
            ))}

            <div className="bsl-row" style={{ marginTop: 8, borderTop: "1px solid hsl(var(--border))", paddingTop: 10 }}>
              <Field label="Name (optional)" help="Defaults to the actual Figma file name.">
                <Input value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} placeholder="Client A" />
              </Field>
              <Field label="Target file URL">
                <Input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://www.figma.com/design/…" />
              </Field>
              <Field label="Associated variable library (optional)">
                <Select value={targetVarLib} onChange={(e) => setTargetVarLib(e.target.value)}>
                  <option value="">— none —</option>
                  {enabledVarLibs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              {targetError && <div className="bsl-log-line-error">{targetError}</div>}
              <Button full disabled={savingTarget || !config.hasToken} onClick={addTarget}>
                {savingTarget ? "Checking…" : "Add target library"}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {tab === "swap" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 12 }}>
          {!config.base || config.targets.length === 0 ? (
            <Card title="Incomplete configuration">
              <div className="bsl-help">
                Go to the Configuration tab to set the reference library
                {!config.base ? "" : " (done)"} and add at least one target library.
              </div>
            </Card>
          ) : (
            <>
              <Card title="Libraries">
                <Field label="Target library">
                  <Select value={selectedTargetId} onChange={(e) => setSelectedTargetId(e.target.value)}>
                    {config.targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selectedTarget && (
                  <RadioGroup
                    value={direction}
                    onChange={setDirection}
                    options={[
                      {
                        value: "BaseToTarget",
                        label: `${config.base.fileName} → ${selectedTarget.label}`,
                        description: "Replaces reference assets with their equivalents in the target",
                      },
                      {
                        value: "TargetToBase",
                        label: `${selectedTarget.label} → ${config.base.fileName}`,
                        description: "Replaces target assets with their equivalents in the reference",
                      },
                    ]}
                  />
                )}
              </Card>

              <Card title="Scope">
                <RadioGroup
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "selection", label: "Current selection", description: hasSelection ? "Frame, section, or selected elements" : "Nothing selected — falls back to the whole page" },
                    { value: "page", label: "Whole page", description: "Processes every element on the active page" },
                  ]}
                />
                {scopeInfo && <div className="bsl-help">{scopeInfo.label} · {scopeInfo.count} nodes</div>}
              </Card>

              <Button full disabled={running} onClick={runSwap}>
                {running ? "Swapping…" : "Run swap"}
              </Button>

              {running && (
                <Card title="Progress">
                  <div className="bsl-row-inline" style={{ justifyContent: "space-between" }}>
                    <Badge>{phase ? PHASE_LABEL[phase] : "Preparing…"}</Badge>
                    <span className="bsl-help">{(elapsedMs / 1000).toFixed(1)}s</span>
                  </div>
                  <Progress value={phaseDone} max={phaseTotal || 1} />
                  <div className="bsl-help">
                    {phaseTotal > 0 ? `${phaseDone} / ${phaseTotal}` : "…"}
                  </div>
                  <Button variant="destructive" onClick={() => send({ type: "cancel-swap" })}>
                    Cancel
                  </Button>
                </Card>
              )}

              {errorMsg && (
                <Card title="Error">
                  <div className="bsl-log-line-error">{errorMsg}</div>
                </Card>
              )}

              {result && (
                <Card title="Result">
                  <div className="bsl-counts-grid">
                    <div className="bsl-count-box">
                      <div className="bsl-count-value">{result.counts.components}</div>
                      <div className="bsl-count-label">Components</div>
                    </div>
                    <div className="bsl-count-box">
                      <div className="bsl-count-value">{result.counts.variables}</div>
                      <div className="bsl-count-label">Variables</div>
                    </div>
                    <div className="bsl-count-box">
                      <div className="bsl-count-value">{result.counts.textStyles}</div>
                      <div className="bsl-count-label">Text styles</div>
                    </div>
                    <div className="bsl-count-box">
                      <div className="bsl-count-value">{result.counts.effectStyles}</div>
                      <div className="bsl-count-label">Effects</div>
                    </div>
                  </div>
                  <div className="bsl-help">Done in {(result.elapsedMs / 1000).toFixed(1)}s</div>

                  {result.unmatched.length > 0 && (
                    <>
                      <div className="bsl-label">{result.unmatched.length} not swapped (no match found)</div>
                      <div className="bsl-log">
                        {result.unmatched.map((u, i) => (
                          <div key={i} className="bsl-log-line-warn bsl-log-line">
                            [{u.category}] {u.name} — {u.nodeName}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
