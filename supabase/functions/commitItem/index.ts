// commitItem/index.ts – Supabase Edge Function to commit to an item
import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  }
  return null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  const userId = await getUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  try {
    const body = await req.json();
    const { itemId, quantity, eventSlug } = body;
    if (isNaN(quantity) || quantity < 0) {
      return new Response(JSON.stringify({ error: "Invalid commitment quantity" }), { status: 400 });
    }
    const { data: eventData } = await supabase
      .from("events")
      .select("id, slug")
      .eq("slug", eventSlug)
      .maybeSingle();
    if (!eventData) {
      return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    }
    const { data: itemData, error: itemError } = await supabase
      .from("event_items")
      .select("quantity_required")
      .eq("id", itemId)
      .single();
    if (itemError || !itemData) {
      return new Response(JSON.stringify({ error: "Item not found" }), { status: 404 });
    }
    const requiredQuantity = itemData.quantity_required;
    const { data: commitmentsData } = await supabase
      .from("commitments")
      .select("quantity")
      .eq("item_id", itemId);
    const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
    const { data: myCommitData } = await supabase
      .from("commitments")
      .select("quantity")
      .eq("item_id", itemId)
      .eq("user_id", userId)
      .maybeSingle();
    const myCurrent = myCommitData ? myCommitData.quantity : 0;
    const available = requiredQuantity - (totalCommitted - myCurrent);
    if (quantity > available) {
      return new Response(
        JSON.stringify({ error: `Cannot commit ${quantity}. Only ${available} slots available.` }),
        { status: 400 }
      );
    }
    const { error } = await supabase
      .from("commitments")
      .upsert([{
        event_id: eventData.id,
        user_id: userId,
        item_id: itemId,
        quantity,
      }], { onConflict: ["event_id", "user_id", "item_id"] });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
    return new Response(JSON.stringify({ message: "Commitment successful" }), { headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
