import "dotenv/config";
import express from "express";
import cors from "cors";
import { spawn, execSync } from "child_process";
import { randomUUID } from "crypto";

const PORT = parseInt(process.env.PORT || "18789", 10);
const TOKEN = process.env.CLAUDE_CODE_TOKEN;
const SYNAPSE_API = process.env.SYNAPSE_API_URL || "http://localhost:8000";

if (!TOKEN) {
  console.error("[ERROR] CLAUDE_CODE_TOKEN environment variable is required.");
  process.exit(1);
}

// Verify claude CLI is available on startup
try {
  const version = execSync("claude --version", { encoding: "utf-8" }).trim();
  console.log(`[Startup] claude CLI found: ${version}`);
} catch {
  console.error("[ERROR] 'claude' not found in PATH. Install Claude Code first.");
  process.exit(1);
}

const SYSTEM_PROMPT = `Eres SYNAPSE AI, el asesor de manufactura inteligente de Planta Norte.
El usuario te habla a través de gafas inteligentes Meta Ray-Ban mientras camina por la planta.
Responde siempre en español, de forma concisa y accionable — tu respuesta se escucha por voz.
No uses markdown, listas con guiones ni formato especial — habla como lo haría un colega experto.

CAPACIDADES:
Tienes acceso en tiempo real a todos los sistemas de la planta a través de la API SYNAPSE.
Usa los endpoints para obtener datos reales antes de responder sobre KPIs, estaciones, AGVs o almacén.
Cuando detectes problemas, prioriza por impacto en producción y da recomendaciones concretas y cuantificadas.
Puedes registrar incidentes, crear órdenes de material y reconocer alarmas directamente desde aquí.

API SYNAPSE (base: ${SYNAPSE_API}):

CONSULTAS:
  GET /api/v1/plant/kpis              — OEE global, throughput, uptime, scrap, energía, alertas activas
  GET /api/v1/history                 — historial de 120 puntos: oee, throughput, energy, defects, pressure, humidity
  GET /api/v1/plant-definition        — definición estática: estaciones, rutas AGV, zonas de almacén
  GET /api/v1/stations                — todas las estaciones con OEE, throughput, temperatura, estado
  GET /api/v1/stations/{id}           — detalle de una estación (ej. ST-03)
  GET /api/v1/agv/fleet               — flota completa de AGVs: estado, batería, carga, progreso
  GET /api/v1/agv/{id}                — detalle de un AGV (ej. AGV-01)
  GET /api/v1/warehouse/stock         — stock actual por zona vs capacidad y tasa de consumo
  GET /api/v1/incidents               — incidentes ordenados por fecha, con severidad y estatus
  GET /api/v1/orders                  — órdenes de material: estado, proveedor, ETA, prioridad
  GET /api/v1/alarms                  — log de alarmas activas y reconocidas
  GET /api/v1/materials               — catálogo de materiales con tiempos de entrega
  GET /api/v1/suppliers               — proveedores con rating y % de cumplimiento

ACCIONES:
  POST /api/v1/incidents
    body: { "type": str, "station": str, "description": str, "severity": "Baja"|"Media"|"Alta"|"Crítica" }
    → registra un incidente nuevo en la planta

  POST /api/v1/orders
    body: { "material": code, "materialName": str, "qty": int, "unit": str, "supplier": str, "priority": "normal"|"alta"|"urgente", "notes": str }
    → crea una orden de compra de material

  PATCH /api/v1/incidents/{id}/resolve   — marca un incidente como resuelto
  PATCH /api/v1/alarms/{id}/ack          — reconoce una alarma

INSTRUCCIONES DE USO:
- Antes de responder sobre datos de planta, SIEMPRE consulta el endpoint relevante con curl.
- Ejemplo: curl -s ${SYNAPSE_API}/api/v1/plant/kpis
- Interpreta los datos y responde con números reales, no estimaciones.
- Si el usuario reporta un problema que está viendo, regístralo como incidente usando POST /api/v1/incidents.
- Si detectas stock bajo (< 20% de capacidad) al consultar almacén, sugiérelo proactivamente.
- Para problemas de AGV, consulta /api/v1/agv/fleet y da la ID del AGV afectado.`;

// Maps our stable conversation IDs to Claude Code session IDs
const sessions = new Map<string, string>(); // conversationId → claudeSessionId

interface ChatRequest {
  text: string;
  images?: string[];
  conversation_id?: string;
}

// ── Claude CLI ──────────────────────────────────────────────────────────────

function runClaude(
  prompt: string,
  claudeSessionId: string | undefined,
): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const args = ["--print", "--output-format", "json", "--dangerously-skip-permissions", "--system-prompt", SYSTEM_PROMPT];
    if (claudeSessionId) args.push("--resume", claudeSessionId);

    console.log(`  [claude] spawn: claude ${args.join(" ")}`);
    console.log(`  [claude] prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}`);

    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;
      // Surface stderr lines in real time so tool calls are visible
      process.stderr.write(`  [claude stderr] ${line}`);
    });

    child.on("close", (code: number | null) => {
      console.log(`  [claude] exit code: ${code}`);
      if (stdout) console.log(`  [claude] stdout (${stdout.length} bytes): ${stdout.slice(0, 300)}${stdout.length > 300 ? "…" : ""}`);

      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.is_error) {
          reject(new Error(json.result ?? "Claude returned an error"));
          return;
        }
        resolve({ result: json.result ?? "", sessionId: json.session_id ?? "" });
      } catch {
        reject(new Error(`Failed to parse claude output: ${stdout.slice(0, 200)}`));
      }
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Log every incoming request
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    console.warn(`  [auth] REJECTED — got: "${auth.slice(0, 30)}"`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/health", requireAuth, (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// ── Reset ───────────────────────────────────────────────────────────────────

app.post("/reset", requireAuth, (req, res) => {
  const { conversation_id } = (req.body ?? {}) as { conversation_id?: string };
  if (conversation_id) {
    sessions.delete(conversation_id);
    console.log(`  [reset] cleared conversation ${conversation_id}`);
  } else {
    sessions.clear();
    console.log(`  [reset] cleared all sessions`);
  }
  res.json({ ok: true });
});

// ── Chat ────────────────────────────────────────────────────────────────────

app.post("/chat", requireAuth, async (req, res) => {
  const body = req.body as ChatRequest;

  if (!body.text && (!body.images || body.images.length === 0)) {
    res.status(400).json({ error: "Must provide text or images" });
    return;
  }

  const conversationId = body.conversation_id || randomUUID();
  const claudeSessionId = sessions.get(conversationId);

  console.log(`  [chat] conversation=${conversationId} | session=${claudeSessionId ?? "new"}`);

  const t0 = Date.now();
  try {
    const text = body.text || "What do you see?";
    const { result, sessionId: newSessionId } = await runClaude(text, claudeSessionId);

    if (newSessionId) sessions.set(conversationId, newSessionId);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [chat] done in ${elapsed}s | result: ${result.slice(0, 120)}${result.length > 120 ? "…" : ""}`);

    res.json({ text: result, conversation_id: conversationId });
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [chat] ERROR after ${elapsed}s: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ── Task (legacy compatibility) ─────────────────────────────────────────────
// Supports the old { task } → { result } format used by the previous server.mjs.
// Can be removed once the updated Android app is deployed.

app.post("/task", requireAuth, async (req, res) => {
  const { task } = (req.body ?? {}) as { task?: string };
  if (!task) {
    res.status(400).json({ error: "Missing task" });
    return;
  }

  console.log(`  [task→chat] "${task.slice(0, 100)}${task.length > 100 ? "…" : ""}"`);

  const t0 = Date.now();
  try {
    const { result, sessionId } = await runClaude(task, sessions.get("legacy"));
    if (sessionId) sessions.set("legacy", sessionId);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [task] done in ${elapsed}s | result: ${result.slice(0, 120)}${result.length > 120 ? "…" : ""}`);

    res.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [task] ERROR: ${message}`);
    res.status(500).json({ error: message });
  }
});

// ── Catch-all (helps diagnose wrong URLs) ───────────────────────────────────

app.use((req, res) => {
  console.warn(`  [404] ${req.method} ${req.path} — no route matched`);
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Claude Gateway  ·  port ${PORT}      ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  GET  /health                        ║`);
  console.log(`║  POST /chat   { text, images? }      ║`);
  console.log(`║  POST /reset  { conversation_id? }   ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
