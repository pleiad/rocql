// Observa diagnostics de VsRocq (publisher: rocq-prover) para decidir si un
// .v está "verde" (verificado por el kernel sin errores). No tenemos acceso
// al rango procesado interno (lo emite por una notificación LSP privada al
// cliente que VsRocq controla), así que usamos el inverso: ausencia de
// diagnostics + ventana de quietud configurable según el modo de VsRocq.
//
// El consumidor escucha onVerificationChanged y decide qué hacer (en nuestra
// caso, programar un harvest de dpdgraph para el módulo del archivo verde).

import * as vscode from 'vscode';

/**
 * - `unknown`: sin información todavía. Estado inicial.
 * - `has-errors`: VsRocq reportó diagnostics de severidad Error.
 * - `likely-green`: sin errores durante la ventana de quietud. Para modo
 *   `continuous` es señal fuerte; en `manual` es señal débil (puede que el
 *   usuario simplemente no haya avanzado el checkpoint).
 */
export type VerificationState = 'unknown' | 'has-errors' | 'likely-green';

export interface VerificationEvent {
  uri: vscode.Uri;
  state: VerificationState;
}

export class VerificationTracker implements vscode.Disposable {
  private state = new Map<string, VerificationState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private subs: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<VerificationEvent>();
  readonly onDidChange = this.emitter.event;

  start(): void {
    this.subs.push(
      vscode.languages.onDidChangeDiagnostics((evt) => this.onChange(evt)),
    );
    // Estado inicial: barrer .v actualmente abiertos.
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isRocqFile(editor.document.uri)) {
        this.evaluate(editor.document.uri);
      }
    }
  }

  dispose(): void {
    while (this.subs.length) this.subs.pop()?.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.emitter.dispose();
  }

  getState(uri: vscode.Uri): VerificationState {
    return this.state.get(uri.toString()) ?? 'unknown';
  }

  private onChange(evt: vscode.DiagnosticChangeEvent): void {
    for (const uri of evt.uris) {
      if (!this.isRocqFile(uri)) continue;
      this.evaluate(uri);
    }
  }

  private isRocqFile(uri: vscode.Uri): boolean {
    return uri.fsPath.endsWith('.v');
  }

  private evaluate(uri: vscode.Uri): void {
    const key = uri.toString();
    const diagnostics = vscode.languages.getDiagnostics(uri);
    const hasErrors = diagnostics.some(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    );

    // Cancelar timer anterior si lo hay.
    const prevTimer = this.timers.get(key);
    if (prevTimer) clearTimeout(prevTimer);
    this.timers.delete(key);

    if (hasErrors) {
      this.transitionTo(uri, 'has-errors');
      return;
    }

    // Sin errores. Programamos likely-green tras la ventana de quietud
    // dependiente del modo de VsRocq.
    const delay = this.greenDelayMs();
    const t = setTimeout(() => {
      this.timers.delete(key);
      // Reverificar al disparar: pudo haber llegado un diagnostic entre tanto
      // sin reentrar a evaluate (poco probable, pero barato chequear).
      const stillClean =
        vscode.languages
          .getDiagnostics(uri)
          .filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length ===
        0;
      if (stillClean) this.transitionTo(uri, 'likely-green');
    }, delay);
    this.timers.set(key, t);
  }

  private transitionTo(uri: vscode.Uri, state: VerificationState): void {
    const key = uri.toString();
    const prev = this.state.get(key);
    if (prev === state) return;
    this.state.set(key, state);
    this.emitter.fire({ uri, state });
  }

  /**
   * Ventana de quietud antes de declarar `likely-green`. En modo `continuous`
   * VsRocq verifica conforme tipeas, así que "sin errores" se vuelve estable
   * rápido. En `manual` el usuario avanza con Cmd+Alt+Down: damos más margen
   * porque "sin errores" no implica que haya pasado por todo el archivo.
   *
   * VsRocq 2.x publica `vsrocq.proof.mode` como enum numérico: 0 = continuous,
   * 1 = manual (confirmed contra el package.json del paquete). Toleramos
   * también string por si la API cambia.
   */
  private greenDelayMs(): number {
    const raw = vscode.workspace
      .getConfiguration('vsrocq')
      .get<number | string>('proof.mode', 1);
    const isContinuous =
      raw === 0 ||
      (typeof raw === 'string' && raw.toLowerCase() === 'continuous');
    return isContinuous ? 2000 : 8000;
  }
}

/** Devuelve true si VsRocq está instalada (publisher rocq-prover.vsrocq). */
export function isVsRocqInstalled(): boolean {
  return vscode.extensions.getExtension('rocq-prover.vsrocq') !== undefined;
}
