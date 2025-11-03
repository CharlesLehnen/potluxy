// functions/send-reminders/index.ts
// Supabase Edge Function (Deno) – send reminder emails via Resend

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ───────────────────────────────────────────────────────────
// 1) env from Supabase → Edge Function Secrets
// ───────────────────────────────────────────────────────────
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PROJECT_URL = Deno.env.get("PROJECT_URL") ?? ""; // e.g. https://your-site.example

// Use your verified domain/sender later
const DEFAULT_FROM = "onboarding@resend.dev";

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

// ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  try {
    const { event_id } = await req.json();
    if (!event_id) return json({ error: "event_id is required" }, 400);

    // 1) Event
    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("*")
      .eq("id", event_id)
      .single();
    if (eventErr || !event) return json({ error: "Event not found" }, 404);

    // Match your column name
    if (!event.collect_emails) {
      return json(
        {
          ok: true,
          sent: 0,
          note:
            "Event has collect_emails = false, so no reminder emails were sent.",
        },
        200
      );
    }

    // 2) Attendees
    const { data: attendees, error: attendeesErr } = await supabase
      .from("event_users")
      .select("id, username, real_email, wants_reminders")
      .eq("event_id", event_id);
    if (attendeesErr) return json({ error: attendeesErr.message }, 500);

    // 3) Commitments
    const { data: commitments, error: commitsErr } = await supabase
      .from("commitments")
      .select("user_id, item_id, quantity")
      .eq("event_id", event_id);
    if (commitsErr) return json({ error: commitsErr.message }, 500);

    // 4) Items (for names)
    const { data: items, error: itemsErr } = await supabase
      .from("event_items")
      .select("id, item_name")
      .eq("event_id", event_id);
    if (itemsErr) return json({ error: itemsErr.message }, 500);

    // 5) Host's real email (for the contact link)
    const { data: hostRow } = await supabase
      .from("event_users")
      .select("real_email")
      .eq("event_id", event_id)
      .eq("username", event.created_by)
      .maybeSingle();

    const hostEmail: string | null =
      (hostRow && hostRow.real_email) ? hostRow.real_email : null;

    // lookups
    const itemNameById: Record<string, string> = {};
    (items ?? []).forEach((it) => (itemNameById[it.id] = it.item_name));

    const commitsByUser: Record<
      string,
      Array<{ item_id: string; quantity: number }>
    > = {};
    (commitments ?? []).forEach((c) => {
      if (!c.user_id) return;
      (commitsByUser[c.user_id] ??= []).push({
        item_id: c.item_id,
        quantity: c.quantity,
      });
    });

    if (!RESEND_API_KEY) {
      return json(
        {
          error:
            "RESEND_API_KEY is not configured in Edge Function secrets. No emails sent.",
        },
        500
      );
    }

    // 6) Send mails (ignore wants_reminders if host requires)
    let sent = 0;
    const errors: Array<{ to: string; error: string }> = [];

    for (const att of attendees ?? []) {
      if (!att.real_email) continue;

      const userCommits = commitsByUser[att.id] ?? [];
      const commitLines =
        userCommits.length > 0
          ? userCommits
              .map((c) => {
                const name = itemNameById[c.item_id] ?? "Unknown item";
                return `<li>${name} – ${c.quantity}</li>`;
              })
              .join("")
          : "<li>(You have not committed to anything yet)</li>";

      const subject = `Reminder for ${event.event_name}`;
      const eventUrl = event.slug
        ? `${PROJECT_URL}/#/event/${event.slug}`
        : "#";

      const hostContactBlock = hostEmail
        ? `<p>Questions? Email the host (${event.created_by}): <a href="mailto:${hostEmail}">${hostEmail}</a></p>`
        : `<p>Questions for the host (${event.created_by})? Open the event page for contact info: <a href="${eventUrl}">${eventUrl}</a></p>`;

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

          ${hostContactBlock}

          <hr/>
          <p style="font-size:12px;color:#999">
            Sent on behalf of the event host (${event.created_by}). Replies to this email are not monitored.
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
          body: JSON.stringify({
            from: DEFAULT_FROM,
            to: att.real_email,
            subject,
            html,
          }),
        });

        if (!r.ok) {
          const text = await r.text();
          errors.push({ to: att.real_email, error: text });
        } else {
          sent++;
        }
      } catch (err) {
        errors.push({ to: att.real_email, error: String(err) });
      }
    }

    return json({ ok: true, sent, errors }, 200);
  } catch (err) {
    console.error("send-reminders error:", err);
    return json({ error: String(err) }, 500);
  }
});

// ───────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
