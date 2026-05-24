// Inline keyboard for /persona. Two columns of buttons; callback_data
// encodes the slug so the callback handler can resolve back to a Persona.

import { InlineKeyboard } from 'grammy';
import type { Persona } from '../../services/persona.js';

export const PERSONA_CALLBACK_PREFIX = 'persona:';

export function buildPersonaKeyboard(
  personas: Persona[],
  t: (key: string) => string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  personas.forEach((p, idx) => {
    const label = `${p.emoji} ${t(p.nameKey)}`;
    kb.text(label, `${PERSONA_CALLBACK_PREFIX}${p.slug}`);
    // Two buttons per row.
    if (idx % 2 === 1) kb.row();
  });
  return kb;
}
