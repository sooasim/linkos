// 06_EVENT_CATALOG.yaml 과 1:1 대응. 이름/페이로드 키를 바꾸지 말 것.
export interface DomainEvents {
  "exchange.session.created": { session_id: string; sender_id: string; channel_candidates: string[]; expires_at: string };
  "exchange.channel.attempted": { session_id: string; channel: string; outcome: string; latency_ms: number | null };
  "exchange.receiver.opened": { session_id: string; anonymous_receiver_id: string };
  "exchange.completed": { relationship_ids: string[]; encounter_id: string };
  "guest.claimed": { guest_claim_id: string; user_id: string };
  "card.extraction.completed": { card_id: string; fields: string[]; confidence: Record<string, number> };
  "contact.updated": { contact_id: string; changed_fields: string[] };
  "profile.updated": { profile_id: string; changed_fields: string[]; version: number };
  "meeting.transcript.ready": { meeting_id: string; transcript_ref: string };
  "meeting.actions.extracted": { meeting_id: string; action_item_ids: string[] };
  "match.created": { subject_id: string; candidate_id: string; score: number; reasons: string[] };
  "followup.due": { followup_id: string; user_id: string };
  "integration.sync.failed": { provider: string; job_id: string; error_class: string };
  "privacy.deletion.requested": { subject_id: string; deadline: string };
}

export type DomainEventName = keyof DomainEvents;

export const EVENT_CONSUMERS: Record<DomainEventName, string[]> = {
  "exchange.session.created": ["analytics", "notification"],
  "exchange.channel.attempted": ["analytics"],
  "exchange.receiver.opened": ["growth-service", "notification"],
  "exchange.completed": ["growth-service", "integration-service", "ai-orchestrator"],
  "guest.claimed": ["growth-service", "relationship-service"],
  "card.extraction.completed": ["relationship-service", "ai-orchestrator"],
  "contact.updated": ["integration-service", "search-index", "match-service"],
  "profile.updated": ["match-service", "notification"],
  "meeting.transcript.ready": ["ai-orchestrator"],
  "meeting.actions.extracted": ["meeting-service", "communication-service"],
  "match.created": ["notification", "analytics"],
  "followup.due": ["notification"],
  "integration.sync.failed": ["notification", "ops"],
  "privacy.deletion.requested": ["all-data-services"],
};
