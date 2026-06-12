"use strict";
// Observa diagnostics de VsRocq (publisher: rocq-prover) para decidir si un
// .v está "verde" (verificado por el kernel sin errores). No tenemos acceso
// al rango procesado interno (lo emite por una notificación LSP privada al
// cliente que VsRocq controla), así que usamos el inverso: ausencia de
// diagnostics + ventana de quietud configurable según el modo de VsRocq.
//
// El consumidor escucha onVerificationChanged y decide qué hacer (en nuestra
// caso, programar un harvest de dpdgraph para el módulo del archivo verde).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VerificationTracker = void 0;
exports.isVsRocqInstalled = isVsRocqInstalled;
const vscode = __importStar(require("vscode"));
class VerificationTracker {
    state = new Map();
    timers = new Map();
    subs = [];
    emitter = new vscode.EventEmitter();
    onDidChange = this.emitter.event;
    start() {
        this.subs.push(vscode.languages.onDidChangeDiagnostics((evt) => this.onChange(evt)));
        // Estado inicial: barrer .v actualmente abiertos.
        for (const editor of vscode.window.visibleTextEditors) {
            if (this.isRocqFile(editor.document.uri)) {
                this.evaluate(editor.document.uri);
            }
        }
    }
    dispose() {
        while (this.subs.length)
            this.subs.pop()?.dispose();
        for (const t of this.timers.values())
            clearTimeout(t);
        this.timers.clear();
        this.emitter.dispose();
    }
    getState(uri) {
        return this.state.get(uri.toString()) ?? 'unknown';
    }
    onChange(evt) {
        for (const uri of evt.uris) {
            if (!this.isRocqFile(uri))
                continue;
            this.evaluate(uri);
        }
    }
    isRocqFile(uri) {
        return uri.fsPath.endsWith('.v');
    }
    evaluate(uri) {
        const key = uri.toString();
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const hasErrors = diagnostics.some((d) => d.severity === vscode.DiagnosticSeverity.Error);
        // Cancelar timer anterior si lo hay.
        const prevTimer = this.timers.get(key);
        if (prevTimer)
            clearTimeout(prevTimer);
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
            const stillClean = vscode.languages
                .getDiagnostics(uri)
                .filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length ===
                0;
            if (stillClean)
                this.transitionTo(uri, 'likely-green');
        }, delay);
        this.timers.set(key, t);
    }
    transitionTo(uri, state) {
        const key = uri.toString();
        const prev = this.state.get(key);
        if (prev === state)
            return;
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
    greenDelayMs() {
        const raw = vscode.workspace
            .getConfiguration('vsrocq')
            .get('proof.mode', 1);
        const isContinuous = raw === 0 ||
            (typeof raw === 'string' && raw.toLowerCase() === 'continuous');
        return isContinuous ? 2000 : 8000;
    }
}
exports.VerificationTracker = VerificationTracker;
/** Devuelve true si VsRocq está instalada (publisher rocq-prover.vsrocq). */
function isVsRocqInstalled() {
    return vscode.extensions.getExtension('rocq-prover.vsrocq') !== undefined;
}
//# sourceMappingURL=verification.js.map