import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';

export interface SendRecipientArgs {
  phoneNumberId: string;
  /** Already-decrypted Meta access token. */
  accessToken: string;
  /** ⭐ Identidade de quem recebe. `phone` é só o endereço de entrega. */
  contactId: string;
  phone: string;
  templateName: string;
  language: string;
  /** Loaded once by the caller so we don't N+1 the template row. */
  templateRow?: MessageTemplate | null;
  /** Body variable values, one per {{N}}. */
  params?: string[];
  /** Structured per-send values (header text / media / button values). */
  messageParams?: SendTimeParams;
}

export type SendRecipientResult = { messageId: string } | { error: string };

/**
 * Send one template message to one recipient, with the trunk-prefix
 * phone-variant retry: numbers that differ only in a leading trunk `0`
 * still reach the contact on a "not in allowed list" bounce.
 *
 * Extracted verbatim from the /api/whatsapp/broadcast route loop so the
 * route and the server-side broadcast dispatcher send identically.
 */
export async function sendTemplateToRecipient(
  args: SendRecipientArgs,
): Promise<SendRecipientResult> {
  const sanitized = sanitizePhoneForMeta(args.phone);
  if (!isValidE164(sanitized)) {
    return { error: 'Invalid phone number format' };
  }

  const variants = phoneVariants(sanitized);
  let lastError: string | null = null;

  for (const variant of variants) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        to: variant,
        contactId: args.contactId,
        templateName: args.templateName,
        language: args.language,
        template: args.templateRow ?? undefined,
        messageParams: args.messageParams,
        params: args.params ?? [],
      });
      return { messageId: result.messageId };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      lastError = errorMessage;
      // Only a "recipient not allowed" bounce is worth retrying with the
      // next phone variant; anything else is a hard failure.
      if (!isRecipientNotAllowedError(errorMessage)) break;
    }
  }

  return { error: lastError || 'Unknown error' };
}
