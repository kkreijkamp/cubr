// The part of web-push 4 (ESM, no types of its own) that the daily reminders use.
declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  export class WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | null,
    options?: { TTL?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; vapidDetails?: VapidDetails; timeout?: number; topic?: string },
  ): Promise<SendResult>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
}
