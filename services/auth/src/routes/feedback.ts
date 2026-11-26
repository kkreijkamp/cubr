import type { FastifyInstance } from 'fastify';
import { parse, rateLimited, unavailable } from '@cubr/common';
import { quietLogLevel } from './clientErrors.js';
import type { Deps } from './index.js';
import { allow, allowIfCounted } from '../safe.js';
import { loadMailConfig, sendMail } from '../mail.js';
import { FEEDBACK_LIMITS as L, feedbackEmail, feedbackSchema } from '../feedback.js';

/**
 * POST /api/feedback: the footer's feedback form (web/src/components/FeedbackModal.tsx). The message is
 * emailed to cubr's inbox (MAIL_REPLY_TO, hello@cubr.dev), with replies going to the address the person
 * gave, if any, and nothing is stored. If it can't be emailed (past the daily cap, Redis can't count,
 * Resend refuses), the answer is 503 and the form keeps the text, pointing to the email button. As for
 * /api/errors, the route logs no request lines (they carry the visitor's IP address) and the gateway
 * doesn't log it either, so a message is never recorded next to an address; the address is only used,
 * briefly, for the rate limits. Its own log lines go through the service's logger, at its level.
 */
export async function registerFeedbackRoutes(app: FastifyInstance, { config, redis }: Deps) {
  const mail = loadMailConfig();
  const logLevel = quietLogLevel(config.logLevel);
  const cantSend = () => unavailable("Feedback can't be sent right now");

  app.post('/api/feedback', { bodyLimit: L.bodyBytes, logLevel }, async (req, reply) => {
    if (!(await allow(redis, `feedback:${req.ip}`, L.perIp, L.perIpWindowSec)) || !(await allow(redis, `feedback-day:${req.ip}`, L.perIpDay, 86_400))) {
      throw rateLimited('Too many messages, try again later');
    }
    const feedback = parse(feedbackSchema, req.body ?? {});
    if (!(await allowIfCounted(redis, 'feedback:all', L.total, L.totalWindowSec))) {
      app.log.warn('feedback: not sent, past the daily cap or Redis is unavailable');
      throw cantSend();
    }
    try {
      await sendMail(mail, { to: mail.replyTo, replyTo: feedback.email, ...feedbackEmail(feedback) }, app.log);
    } catch (err) {
      app.log.error({ err: (err as Error).message }, 'feedback: the email failed');
      throw cantSend();
    }
    app.log.info({ kind: feedback.kind, replyTo: feedback.email !== undefined }, 'feedback sent');
    return reply.status(204).send();
  });
}
