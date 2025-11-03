// functions/send-reminders/index.ts
// Deno / Supabase Edge Function

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 1) read env
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// OPTIONAL: change this to your verified sender on Resend
const DEFAULT_FROM = "onboarding@resend.dev"; // 👈 change later

if (!RESEND_API_KEY) {
  console.warn("send-reminders: RESEND_API_KEY is not set");
}

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders(),
    });
  }

  try {
    const { event_id } = await req.json();

    if (!event_id) {
      return json({ error: "event_id is required" }, 400);
    }

    // 1) load the event
    const { data: event, error: eventErr } = await supabase
      .from("events")
      .select("*")
      .eq("id", event_id)
      .single();

    if (eventErr || !event) {
      return json({ error: "Event not found" }, 404);
    }

    // if host didn't enable email collection, don't send
    if (!event.collect_emails) {
      return json(
        {
          ok: true,
          sent: 0,
          note: "This event has collect_emails = false, so no reminders were sent.",
        },
        200,
      );
    }

    // 2) load attendees for this event
    const { data: attendees, error: attendeesErr } = await supabase
      .from("event_users")
      .select("id, username, real_email, wants_reminders")
      .eq("event_id", event_id);

    if (attendeesErr) {
      return json({ error: attendeesErr.message }, 500);
    }

    // 3) load commitments for this event
    const { data: commitments, error: commitsErr } = await supabase
      .from("commitments")
      .select("user_id, item_id, quantity")
      .eq("event_id", event_id);

    if (commitsErr) {
      return json({ error: commitsErr.message }, 500);
    }

    // 4) load items so we can display names
    const { data: items, error: itemsErr } = await supabase
      .from("event_items")
      .select("id, item_name")
      .eq("event_id", event_id);

    if (itemsErr) {
      return json({ error: itemsErr.message }, 500);
    }

    // make a quick lookup for item names
    const itemNameById: Record<string, string> = {};
    (items || []).forEach((it) => {
      itemNameById[it.id] = it.item_name;
    });

    // group commitments by user
    const commitsByUser: Record<
      string,
      Array<{ item_id: string; quantity: number }>
    > = {};
    (commitments || []).forEach((c) => {
      if (!c.user_id) return;
      if (!commitsByUser[c.user_id]) commitsByUser[c.user_id] = [];
      commitsByUser[c.user_id].push({
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
        500,
      );
    }

    // 5) send emails, but only to attendees that:
    // - have an email
    // - and host wants to collect emails (checked above)
    // - and (IMPORTANT) we *ignore* their wants_reminders flag if the host forced it
    //   BUT you said “I don’t want people to opt out if host wants them”
    //   ==> so we do NOT check attendee.wants_reminders here.
    let sent = 0;
    const errors: Array<{ to: string; error: string }> = [];

    for (const att of attendees || []) {
      if (!att.real_email) continue;

      const userCommits = commitsByUser[att.id] || [];

      const commitLines =
        userCommits.length > 0
          ? userCommits
              .map((c) => {
                const name = itemNameById[c.item_id] || "Unknown item";
                return `<li>${name} – ${c.quantity}</li>`;
              })
              .join("")
          : "<li>(You have not committed to anything yet)</li>";

      const subject = `Reminder for ${event.event_name}`;
      const html = `
        <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
          <p>Hi ${att.username || "there"},</p>
          <p>This is a reminder about <strong>${event.event_name}</strong>.</p>

          ${
            event.event_date
              ? `<p><strong>Date:</strong> ${event.event_date}</p>`
              : ""
          }
          ${
            event.event_time
              ? `<p><strong>Time:</strong> ${event.event_time}</p>`
              : ""
          }
          ${
            event.event_location
              ? `<p><strong>Location:</strong> ${event.event_location}</p>`
              : ""
          }

          <p><strong>What you said you'd bring:</strong></p>
          <ul>${commitLines}</ul>

          <p>See and update your commitments here:<br/>
            <a href="${event.slug
              ? `${Deno.env.get("PROJECT_URL") || ""}/#/event/${event.slug}`
              : "#"}"
            >Open event page</a>
          </p>

          <hr/>
          <p style="font-size: 12px; color: #999;">
            This message was sent on behalf of the event host (${event.created_by}).
            Replies might not be monitored.
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
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// helper to add CORS
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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
