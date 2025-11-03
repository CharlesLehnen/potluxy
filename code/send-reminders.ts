// Supabase Edge Function (Deno) – send reminder emails via Resend
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? ""; // e.g. reminders@yourdomain.com
const COOLDOWN_SEC = Number(Deno.env.get("REMINDER_COOLDOWN_SECONDS") ?? "900"); // 15 min

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { event_id } = await req.json();
    if (!event_id) return json({ error: "event_id is required" }, 400);

    // 1) Load event
    const { data: event, error: eventErr } = await sb
      .from("events").select("*").eq("id", event_id).single();
    if (eventErr || !event) return json({ error: "Event not found" }, 404);

    // respect your schema
    if (!event.collect_real_emails) {
      return json({ ok: true, sent: 0, note: "collect_real_emails is false" });
    }

    // 2) cooldown (server-side)
    const last = event.last_reminder_sent_at ? new Date(event.last_reminder_sent_at).getTime() : 0;
    const now = Date.now();
    const remain = Math.ceil((COOLDOWN_SEC * 1000 - (now - last)) / 1000);
    if (last && remain > 0) {
      return json({ ok: false, sent: 0, cooldown_remaining_seconds: remain, note: "cooldown active" });
    }

    // 3) attendees — try with wants_reminders, fall back if column missing
    let attRes = await sb
      .from("event_users")
      .select("id, username, real_email, wants_reminders")
      .eq("event_id", event_id);

    if (attRes.error && attRes.error.code === "42703") {
      attRes = await sb
        .from("event_users")
        .select("id, username, real_email")
        .eq("event_id", event_id);
    }
    if (attRes.error) return json({ error: attRes.error.message }, 500);
    const attendees = attRes.data ?? [];

    // 4) commitments + items
    const { data: commitments, error: commitsErr } = await sb
      .from("commitments").select("user_id, item_id, quantity").eq("event_id", event_id);
    if (commitsErr) return json({ error: commitsErr.message }, 500);

    const { data: items, error: itemsErr } = await sb
      .from("event_items").select("id, item_name").eq("event_id", event_id);
    if (itemsErr) return json({ error: itemsErr.message }, 500);

    if (!RESEND_API_KEY || !RESEND_FROM) {
      return json({ error: "RESEND_API_KEY or RESEND_FROM not configured in function secrets." }, 500);
    }

    const itemNameById: Record<string, string> = {};
    for (const it of items ?? []) itemNameById[it.id] = it.item_name;

    const commitsByUser: Record<string, Array<{ item_id: string; quantity: number }>> = {};
    for (const c of commitments ?? []) {
      if (!c.user_id) continue;
      (commitsByUser[c.user_id] ??= []).push({ item_id: c.item_id, quantity: c.quantity });
    }

    // 5) send emails
    let sent = 0;
    const errors: Array<{ to: string; error: string }> = [];

    for (const att of attendees) {
      if (!att.real_email) continue;
      if (att.wants_reminders === false) continue; // treat missing as opted-in

      const userCommits = commitsByUser[att.id] ?? [];
      const commitLines = userCommits.length
        ? userCommits.map(c => `<li>${itemNameById[c.item_id] ?? "Unknown item"} – ${c.quantity}</li>`).join("")
        : "<li>(You have not committed to anything yet)</li>";

      const subject = `Reminder for ${event.event_name}`;
      const eventUrl = event.slug ? `${PROJECT_URL}/#/event/${event.slug}` : "#";

      const html = `
        <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <p>Hi ${att.username || "there"},</p>
          <p>This is a reminder about <strong>${event.event_name}</strong>.</p>
          ${event.event_date ? `<p><strong>Date:</strong> ${event.event_date}</p>` : ""}
          ${event.event_time ? `<p><strong>Time:</strong> ${event.event_time}</p>` : ""}
          ${event.event_location ? `<p><strong>Location:</strong> ${event.event_location}</p>` : ""}
          <p><strong>What you said you'd bring:</strong></p>
          <ul>${commitLines}</ul>
          <p>View / update your commitments: <a href="${eventUrl}">${eventUrl}</a></p>
          <hr/>
          <p style="font-size:12px;color:#999">
            Sent on behalf of the event host (${event.created_by}). Replies are not monitored.
          </p>
        </div>
      `;

      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: RESEND_FROM, to: att.real_email, subject, html }),
        });
        if (!r.ok) errors.push({ to: att.real_email, error: await r.text() });
        else sent++;
      } catch (err) {
        errors.push({ to: att.real_email, error: String(err) });
      }
    }

    // 6) record cooldown start
    await sb.from("events").update({ last_reminder_sent_at: new Date().toISOString() }).eq("id", event_id);

    return json({ ok: true, sent, errors });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
