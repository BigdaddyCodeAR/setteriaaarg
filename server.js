// server.js — setter multi-tenant: cada profesional tiene su propia URL de
// webhook y su propio prompt, guardado en Supabase. También sirve el dashboard.

import express from "express";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-5";

// service_role key: SOLO se usa en el servidor, nunca se expone al navegador.
// Ignora las políticas de seguridad (RLS) — por eso es el único que puede escribir.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// -------------------- Llamada a Claude --------------------
function parseReply(raw) {
  const m = raw.match(/<eval>([\s\S]*?)<\/eval>/);
  let ev = {
    etapa: "inicio", status: "conversando", mostrar_resultados: false,
    oferta_presentada: null, score: 0, motivo: "", dia_propuesto: null,
  };
  if (m) { try { ev = JSON.parse(m[1]); } catch (_) {} }
  const rawMessage = raw.replace(/<eval>[\s\S]*?<\/eval>/, "").trim();
  const messages = rawMessage.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean);
  return { messages, ev };
}

async function askClaude(systemPrompt, history) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: history,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// -------------------- Webhook por profesional --------------------
// URL en Manychat: https://tu-server.com/webhook/manychat/<slug-del-profesional>
app.post("/webhook/manychat/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const subscriberId = req.body.subscriber_id || req.body.id;
    const userText = req.body.last_input_text || req.body.message || "";
    const leadNombre = req.body.first_name || null;

    if (!subscriberId || !userText) {
      return res.status(400).json({ error: "Falta subscriber_id o last_input_text" });
    }

    const { data: profesional, error: profErr } = await supabase
      .from("profesionales").select("*").eq("slug", slug).single();
    if (profErr || !profesional) {
      return res.status(404).json({ error: `No existe ningún profesional con slug "${slug}"` });
    }

    // buscar o crear la conversación
    let { data: conv } = await supabase
      .from("conversaciones").select("*")
      .eq("profesional_id", profesional.id).eq("subscriber_id", subscriberId).single();

    if (!conv) {
      const { data: nuevaConv, error: convErr } = await supabase
        .from("conversaciones")
        .insert({ profesional_id: profesional.id, subscriber_id: subscriberId, lead_nombre: leadNombre })
        .select().single();
      if (convErr) throw convErr;
      conv = nuevaConv;
    }

    // traer historial de mensajes de esta conversación
    const { data: previos } = await supabase
      .from("mensajes").select("role, content")
      .eq("conversacion_id", conv.id).order("created_at", { ascending: true });

    const history = [...(previos || []), { role: "user", content: userText }];

    const raw = await askClaude(profesional.system_prompt, history);
    const { messages, ev } = parseReply(raw);

    // guardar el mensaje del lead y la respuesta cruda de la IA
    await supabase.from("mensajes").insert([
      { conversacion_id: conv.id, role: "user", content: userText },
      { conversacion_id: conv.id, role: "assistant", content: raw },
    ]);

    await supabase.from("conversaciones").update({
      etapa: ev.etapa, status: ev.status, score: ev.score,
      oferta_presentada: ev.oferta_presentada, dia_propuesto: ev.dia_propuesto,
      updated_at: new Date().toISOString(),
    }).eq("id", conv.id);

    return res.json({
      version: "v2",
      content: { messages: messages.map(text => ({ type: "text", text })) },
      set_fields: {
        ai_etapa: ev.etapa, ai_status: ev.status, ai_score: ev.score,
        ai_mostrar_resultados: ev.mostrar_resultados,
        ai_oferta_presentada: ev.oferta_presentada || "",
        ai_dia_propuesto: ev.dia_propuesto || "",
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error interno", detail: String(err) });
  }
});

// -------------------- Resumen bajo demanda (lo usa el dashboard) --------------------
// Requiere un JWT de Supabase válido (el dashboard lo manda automático tras el login).
app.get("/api/resumen", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Falta autenticación" });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Sesión inválida" });

    const { data: yo } = await supabase.from("profesionales").select("*").eq("auth_user_id", user.id).single();
    if (!yo) return res.status(403).json({ error: "No sos un profesional registrado" });

    const profesionalId = req.query.profesional_id || yo.id;
    if (profesionalId !== yo.id && !yo.is_admin) {
      return res.status(403).json({ error: "No podés ver los datos de otro profesional" });
    }

    const { data: conversaciones } = await supabase
      .from("conversaciones").select("*").eq("profesional_id", profesionalId)
      .order("updated_at", { ascending: false }).limit(200);

    const resumenDatos = (conversaciones || []).map(c =>
      `- ${c.lead_nombre || c.subscriber_id}: etapa=${c.etapa}, status=${c.status}, score=${c.score}, oferta=${c.oferta_presentada || "-"}, actualizado=${c.updated_at}`
    ).join("\n");

    const prompt = `Sos un asistente que le da un update rápido y claro a un profesional sobre cómo vienen sus leads. Acá está el estado actual de sus conversaciones (una por lead):\n\n${resumenDatos || "(todavía no hay conversaciones)"}\n\nDame un resumen breve y accionable en español rioplatense: cuántos leads en total, cuántos calificados, cuántos con oferta presentada, cuántos con meet propuesto/agendado, y si hay algo que valga la pena que revise hoy.`;

    const texto = await askClaude("Sos un analista de ventas conciso, directo, sin relleno.", [{ role: "user", content: prompt }]);
    return res.json({ resumen: texto });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error interno", detail: String(err) });
  }
});

app.get("/", (_req, res) => res.redirect("/dashboard.html"));

// sirve el dashboard con la URL y la anon key de Supabase ya completadas
app.get("/dashboard.html", async (_req, res) => {
  let html = await readFile("views/dashboard.html", "utf-8");
  html = html
    .replace("__SUPABASE_URL__", process.env.SUPABASE_URL || "")
    .replace("__SUPABASE_ANON_KEY__", process.env.SUPABASE_ANON_KEY || "");
  res.type("html").send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`setter-ia (multi-tenant) escuchando en puerto ${PORT}`));
