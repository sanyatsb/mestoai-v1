# Gonka Bot — Backlog (post-MVP)

Идеи и фичи, **намеренно** не входящие в MVP (§17 [TZ v1.2](Gonka_Bot_MVP_TZ_v1.2.md)). Каждая запись: что, зачем, оценка сложности (S/M/L/XL).

---

## Phase 1.1 — Polish после soft launch (1-2 недели)

| Что | Зачем | Где в TZ/audit | Сложность |
|-----|-------|----------------|-----------|
| Auto-генерация title диалога через `chatComplete` | UX в Phase 2 "list conversations" | TZ §6.1, AUDIT-M13 | S |
| Whisper response cache (sha256 voice → text) | Сэкономить на повторных voice | AUDIT-M15 | S |
| Admin command `/notify_tos_update` | После bump CURRENT_TOS_VERSION — массовая нотификация | AUDIT-B2 | M |
| Anonymize вместо удаления audit_log при /delete_my_data — тесты | Уверенность что GDPR compliant | AUDIT-B3 | S |
| Длинные ответы — `<pre>` форматирование для кода | Лучше читабельность | AUDIT-A4 | S |
| Persona prompts — переводы в локалях | Сейчас prompts на en | AUDIT-L14 | M |
| /about — версия бота, контакт, ToS link | Минимальный info | AUDIT-A2 | S |
| Better Stack настройка (если выбран) | Real-time мониторинг | TZ §12.2 | M |
| Manual QA в каждой из 6 локалей (включая inline keyboards) | RTL и CJK rendering | AUDIT-M14 | M |

---

## Phase 2 — Major features (3-6 недель)

### Streaming UX

| Что | Зачем | Где |
|-----|-------|-----|
| Draft-based streaming через `sendMessageDraft` | Smooth live typing вместо typing-индикатора | AUDIT-C1, X2 |
| Chunked output moderation на каждые 500 знаков | Можно стримить юзеру, прерывать при flagged | AUDIT-C7 |
| AbortController привязать к /new | Прерывать активный стрим при /new | AUDIT-M16 |

### Groups

| Что | Зачем | Где |
|-----|-------|-----|
| **Reply-thread в группах** (multi-turn) | Юзер может продолжить контекст через reply на бота | AUDIT-C9, P5 |
| Mapping (`saveGroupThread`/`getByGroupThread`) | Уже подготовлены поля в schema | TZ §5, §6.9 |
| Native @mention без add-to-group (Bot API 9.6+) | Когда выйдет | TZ §17 |

### Multi-model / Multi-provider

| Что | Зачем | Где |
|-----|-------|-----|
| Multi-model selection (Qwen3, GPT-OSS) | Юзер выбирает модель | TZ §17 |
| Own opengnk proxy | Не зависеть от mingles.ai | TZ §17, Приложение C |
| Fallback chain: mingles.ai → opengnk → direct Gonka | Resilience | — |

### Personas

| Что | Зачем | Где |
|-----|-------|-----|
| User-created custom personas | Юзер пишет свой system prompt | TZ §17 |
| Sharable persona links `t.me/bot?start=persona_xxx` | Виральный рост | TZ §17 |
| Persona switcher как inline-кнопка в каждом ответе | Быстрее переключаться | — |

### Documents

| Что | Зачем | Где |
|-----|-------|-----|
| RAG для документов >200K | Не загружать целиком в context | AUDIT-A5 |
| OCR для scan PDF | Сейчас scan-PDF не работает | TZ §6.5 |
| Document moderation **всего** текста (chunks) | Закрыть обход через payload после 50K | AUDIT-M10 |

### Operations

| Что | Зачем | Где |
|-----|-------|-----|
| Multi-instance horizontal scaling | Больше throughput | AUDIT-A6 |
| BullMQ для background jobs | Распределённая обработка | TZ §2 |
| Multiple admin chats (alerts vs critical vs reports) | Не спамить один канал | AUDIT-L19 |
| Webhook rate limit в Caddy | Защита от DDoS | AUDIT-A9 |

### Monetization

| Что | Зачем | Где |
|-----|-------|-----|
| Платежи / подписки | Sustainable model | TZ §17 |
| Реферальная система | Growth | TZ §17 |
| Premium tier: больше rate limits, voice cache, premium models | Revenue | — |

---

## Phase 3+ — Big bets

| Что | Зачем |
|-----|-------|
| Web search для бота | Расширение возможностей |
| Research-агент с многошаговыми вызовами | Сложные задачи |
| Code-агент с code execution (sandboxed) | Реальная польза для разработчиков |
| Image generation | Modern AI bot must-have |
| Image input / vision (если Kimi vision подтверждён) | Multimodal |
| Bot-to-bot communication | Mesh of agents |
| Chat Automation (AI-секретарь в групповых чатах) | Уникальная фича |
| Managed Bots (создание ботов другим юзерам) | Platform play |
| Custom AI Styles интеграция с TG | Когда появится в Bot API |
| Web-сайт (отдельный проект) | Marketing surface |
| Mobile app (отдельный проект) | Distribution |

---

## Tech debt / nice-to-have

| Что | Где |
|-----|-----|
| Polling fallback если webhook упал | — |
| In-memory cache для kill-switch (TTL 10s) — снизить Redis RTT | AUDIT-H6 |
| BACKLOG ↔ Linear sync | — |
| Coverage threshold bump до 80%+ | TZ §14.1 |
| Pretty CLI output для seed scripts | — |
| Migration rollback strategy | — |
| Staging environment на том же VPS (отдельный port + отдельный бот) | AUDIT-A10 |

---

## Что НЕ делать (anti-backlog)

Идеи которые **сознательно** отвергнуты:

- **Множественные одновременные active conversations на юзера** — усложняет UX, partial unique index гарантирует одну. Если очень надо — Phase 2 через "named threads" UX.
- **Per-message inline-кнопка "Report"** — захламляет чат. `/report` через команду достаточно (AUDIT-M17).
- **Real-time chunked output moderation в MVP** — слишком сложно (race с output moderation, performance, false-positive на половине ответа). Стрим в hidden buffer проще и безопаснее.
- **Self-hosted Whisper в MVP** — Whisper API стоит копейки, поднимать инфру дороже.
- **Custom токенайзер для Kimi** — `usage` из gateway точный, tiktoken-оценка достаточна для guard.
- **Несколько language fallback цепочек** в i18n — en fallback достаточен.

---

**Принцип:** этот файл — место для идей. Реализация — только после soft launch и реальных данных о том, что юзерам нужно. Не строим в надежде "вдруг пригодится".
