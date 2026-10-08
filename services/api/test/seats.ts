// Test fixture helper: F-191 seat entitlement — invites, domain joins, approvals and SCIM provisioning now consume
// seats (billing.assertSeatAvailable). Orgs without a subscription are not capped; tests that exercise limits give the org a
// paid subscription with a known seat count.
import { q } from "../src/lib/db";

export async function grantSeats(orgId: string, seats = 50, plan: "business" | "enterprise" = "business"): Promise<void> {
  await q("INSERT INTO subscriptions (organization_id, plan, status, seats, provider_subscription_id) VALUES ($1,$2,'active',$3,$4)", [orgId, plan, seats, `sub_test_${orgId}`]);
}
