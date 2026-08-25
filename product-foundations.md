# Equestrian Lesson Scheduler — Product Foundations
*Living document — v5, updated 2026-08-21. Update as we learn from real usage.*

*v5 adds structured pricing (Sections 8, 10, 11, 13). The single free `target_price` per lesson type is replaced by a base price plus three named, separately-attributed adjustments — a time-band premium on the slot, a frequency discount held by the student, and a gap-fill discount attached to a coach-initiated offer. There is no separate pricing section: pricing is configured per lesson type on the **Lessons** screen, alongside everything else about that type.*

*v5 adds **liability waivers and disclosures** (Sections 8, 11, 13). Seven coach-editable sections ship with standard wording — risk, waiver of liability, the coach's right to decline, payment and cancellation, horse welfare, how pricing works, and **that the terms themselves can change**. There is deliberately **no version history**: the terms are edited in place, and the changes section is what makes that work — the coach reserves the right to change them at any time after signature, and scheduling a lesson afterwards is the rider's acceptance. Nothing here is legal advice and the product says so.*

*v5 also splits the former **Setup** screen into **Lessons** and **Schedule** (Section 11, 3c and 3d). Setup had become a grab-bag justified only by how rarely the coach opened it; the split follows what the coach is actually deciding — what do I sell, versus when am I free. Lessons holds lesson types, price bands, frequency tiers and cancellation policy; Schedule holds availability windows, time off, and buffers.*

*v3 folds in an audit of the clickable prototype: every coach-side screen was checked for consistency with this doc and with the other screens, and every visible control was made to do something real. Where the prototype revealed a behavior this doc hadn't specified, the behavior is written down below rather than left implicit in code.*

---

## 1. Problem Statement

Equestrian coaches manage lesson scheduling almost entirely by text and phone call. Every reschedule, cancellation, or horse availability change (e.g. a horse goes lame) requires manual back-and-forth. This costs coaches time they don't have margin for, and leaves students without visibility into what's actually open. The interface both sides already trust is text messaging — so the product needs to *be* a texting experience, not redirect people to an app or web form. On top of that, every scheduling decision has to respect horse welfare (usage caps, rest days), safe horse-student pairing, and the coach's business priorities (margin, volume, retention).

**Core value prop:** let the coach's and student's existing texting habit *be* the product — a conversational system that fills every viable lesson slot, protects horse welfare, and only pulls the coach in when a decision genuinely needs a human.

---

## 2. Personas

### 2.1 The Trainer/Coach (primary user, schedule owner)

**Context:** Runs their own lesson program, hands-on at the barn most of the day, thin margins, income depends on utilization. Texts and calls natively; has Gmail but rarely opens it. No patience for new apps, logins, or training.

**Objectives:**
- Utilize every viable lesson opportunity — income depends on it.
- Extend flexibility to students, since it's a known driver of satisfaction and retention.
- Never overwork the horses.
- Always pair the right horse to the right rider for safety.

**Configures (things the system needs to know from them):**
- Windows of availability (e.g. "Tuesdays 8am–5pm").
- Scheduling preferences (e.g. back-to-back lessons, spaced 1h15m apart).
- Student prioritization preferences (e.g. more flex for students riding 8+ times/month).
- Lesson types offered (e.g. 60-min adult private, 45-min child private, 60-min adult group), each with its own pricing: a base price, a floor and ceiling, an amount for each price band, a frequency discount per tier, and a gap-fill discount (Section 8).
- Price bands — up to three named time windows where lessons are worth more or less (e.g. "After school, Mon–Fri 3–6pm"), and the ride counts that earn a frequency discount.
- Business priority (maximize margin vs. volume vs. service — these can trade off against each other).

### 2.2 The Student (primary user, schedule consumer)

**Context:** Rides regularly; may be a teen (parent handles logistics) or an adult managing their own schedule. Texts natively; Gmail rarely opened.

**Objectives:**
- Lock into a recurring schedule that works for them.
- Find opportunities to lower lesson costs.
- Find opportunities for more riding time at a desired cost or with a desired horse.
- Cancel or reschedule with real flexibility when life happens.

### 2.3 Parent/Guardian (proxy variant of Student)
Same texting-native profile, acting on behalf of a minor. The data model below carries guardian contact as a distinct field from the student's own contact, and who receives what is settled rather than open: **everything routes to `guardian_phone` when `age` < 18, to `phone` at 18+**, computed at send time from `age` so it stays correct as a student ages past 18 (Section 8, `Students`). There is no split where some messages go to the minor and others to the guardian — the guardian operates the account outright.

### 2.4 (Future, not MVP) Barn/Facility Owner
Relevant only if this expands to multiple coaches sharing horses/facility. Out of scope for now.

---

## 3. Data Model

*Conceptual sketch from v1, kept because it records what the coach and student said they needed in their own words. **Section 8 is authoritative** wherever the two differ, and several entries here were deliberately superseded: "student types suited to" split into `min_experience_level` + `adult_only`; the six-value riding-styles vocabulary narrowed to English / Western; "saddle assignment" deferred; "business priority" dropped from Phase 1a. Read this section as the requirement, Section 8 as the design.*

### Trainer
| Field | Example |
|---|---|
| Windows of availability | "Tuesdays 8am–5pm" |
| Scheduling preferences | Back-to-back, 1h15m apart |
| Student prioritization preference | Flex more for students riding 8+×/month |
| Lesson types | 60-min adult private, 45-min child private, 60-min adult group |
| Target/min/max price per lesson type | *Superseded — `target_price` became `base_price`, with band, frequency and gap-fill adjustments layered on top, Section 8* |
| Business priority | *Deferred to Phase 2, Section 8* |

### Horse
| Field | Example |
|---|---|
| Name | — |
| Student types suited to | *Superseded — split into `min_experience_level` + `adult_only`, Section 8* |
| Riding styles | *Superseded — narrowed to English / Western, Section 8* |
| Saddle assignment | *Deferred, Section 9* |
| Time-off target | 1 day off/week |
| Max saddle time | 120 min/day (adult riders), 180 min/day (max, all riders) |

### Student
| Field | Example |
|---|---|
| Name, contact info | — |
| Guardian name, contact info | — |
| Emergency contact name, contact info | — |
| Age | — |
| Experience level | Beginner / intermediate / advanced |
| Riding styles | *Superseded — narrowed to English / Western, Section 8* |
| Weight | — |
| Available lesson types | *Dropped — never enforced; see Section 9* |
| Target riding times | Wed 3–5pm PST |
| Potential riding times | Tue 3–5pm, Thu 3–5pm PST |
| Opportunity notification preference | Target only / target+potential / all |
| Favorite horses | *Dropped — read by nothing; replaced by year-to-date ride counts derived from `Bookings`, Section 9* |
| No-ride horses | multi-select, editable by student *and* trainer |
| Notes / communication log | free text |

---

## 4. Features & Proposed Phasing

**Decision:** Build the web app interface first (Phase 1a), then layer in SMS (Phase 1b), on the shared backend/rules engine/data store described in Section 6. Rationale: the web app's structured taps/selects avoid NLU ambiguity, which isolates Phase 1a to validating the rules engine itself (usage caps, pairing, no double-booking) — the highest-risk, highest-importance piece — without the added variable of language understanding. SMS adds real value on top once that logic is proven, at the cost of a second failure surface (correctly interpreting free text) we'd rather not debug simultaneously with the rules engine.

All seven features below are as you defined them. Building all seven as complete flows at once — on either interface — is a big first release; the phasing below is intended to get a usable pilot sooner, and is open to adjustment.

**Phase 1 — MVP pilot (get a real coach + a few students live)**
- **F1. Onboard new student (text flow):** conversational intake → trainer reviews/edits/accepts, sets no-ride horses → system offers 3 initial-lesson times → student accepts or regenerates → booking logged, trainer notified.
- **F2. Recurring schedule setup:** re-confirm profile → system proposes 3 recurring slots with tailored pricing → student accepts/regenerates → if exhausted, system explores moving an existing student (with their confirmation-first, discount-incentive flow you described) → logged, trainer notified. *Discount amount for the displaced student is decided by the trainer case-by-case at the moment it happens, not a fixed or pre-configured rule — the system prompts the trainer for an amount when proposing the move, rather than calculating one itself. **Updated with the pricing model (Section 10):** this remains a case-by-case human decision and deliberately does **not** become a fourth automatic adjustment — being asked to move is not a condition a rule can recognise. It's now written to `manual_adjustment` rather than overwriting `price`, so the affected occurrence's receipt still adds up and the concession is visibly a concession; `notes` captures the reason as before.* Included in Phase 1 given it's likely the single highest-value feature for the trainer's income stability.
- **F5. Daily schedule to trainer:** night-before text with time/student/horse per lesson; flags new students with age, experience, guardian name.
- **F6. Pre-lesson instructions to student:** 2 hrs before, confirms time, horse, tack, cost.
- **F3. Cancel prompts:** weekly review of next 4 lessons (confirm/cancel); 24-hr-prior confirm with payment reminder.

**Phase 2 — fills the gaps a live pilot will surface**
- **F4. Reschedule cancellations:** when a slot opens, text 3 best-fit students/hour (by target-time match, then ride history — favorite horses were dropped, Section 9); first to confirm wins; others notified it's gone.

**Phase 3 — optimization layer, once there's usage data to optimize against**
- **F7. Recommendations engine:** system spots optimization opportunities (for student or trainer goals) → proposes to trainer → if accepted, offers to affected students → respects: prioritize higher-frequency/higher-paying students, never exceed horse max riding time, never move a student to a pricier lesson outside their target time unless it's genuinely a priority slot for them, non-priority offers must cost the same or less than their current rate. Prices always whole numbers, no cents.

---

## 5. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Interface** | Two interfaces, same backend: two-way SMS for users who want pure simplicity, and a lightweight mobile web app for users who want a richer, data-dense view (e.g. seeing a full week grid, or a horse's usage at a glance). Neither requires login or app-store download. Business logic and data must not be duplicated per-interface — both are thin clients over one shared backend. |
| **Conversation quality** | Simple, to the point — no unnecessary personality or filler in messages. When the system isn't fully confident in what a student means, it asks a clarifying question or offers structured choices rather than guessing. |
| **Cost** | No longer strictly $0 — real two-way SMS requires a paid number/carrier (e.g. Twilio-style, ~$1/month + fractions of a cent per message), and the clarifying-question/NLU behavior is a natural fit for the Claude API (small per-message cost). Both are cheap at pilot scale; flagging so it's a conscious tradeoff, not a surprise. |
| **Reliability** | Never double-book a horse or a coach timeslot; never let a booking through that exceeds a horse's max saddle time or violates a no-ride pairing. |
| **Data integrity over polish** | Every rule above holds even under a messy, ambiguous text input — the system must resolve ambiguity via clarifying questions before it commits a change. |
| **Reversibility** | Every data-changing action is reversible for one step (Section 9). Undo restores the prior values of the rows that action wrote — never a whole-state snapshot, since other people may be writing at the same time — and lapses at the next action or the end of the session. |
| **Modularity** | Keep the data store (student/horse/trainer/lesson records), the conversational/NLU layer, and the SMS transport as separable pieces, so each can evolve independently (e.g. swap the data store later, add Calendar sync, add richer optimization logic). |
| **Privacy/security** | Minors' data (age, guardian/emergency contacts) is stored — access to records and any admin views must be scoped, not publicly discoverable. |
| **Scalability** | Confirmed pilot scale: 10-25 students, 15+ horses (likely well under 100 lessons/week). Comfortably within Sheets' range — no pagination or performance design needed for Phase 1. Revisit if the pilot scales meaningfully past this. |

---

## 6. Updated MVP Architecture (proposal — open to revisiting)

**Shared core (used by both interfaces):**
- **Data store** — Google Sheets (trainer, horse, student, lesson records) — still adequate at pilot scale, still free.
- **Rules engine** — deterministic code enforcing horse usage caps, no-ride pairings, no double-booking, and pricing rules. This is the one thing that must never be duplicated or reimplemented per-interface — SMS and web app both call into it and get the same answer.
- **Conversational/NLU layer** — Claude API, used specifically for parsing loose free-text (mainly an SMS need) into structured intents, generating clarifying questions, and drafting plain outbound messages. The web app, since it uses structured taps/selects rather than free text, may need this layer far less — worth confirming once we design its screens.
- **Orchestration/backend** — receives input from either interface, calls the rules engine (and Claude API when the input is free text), writes to Sheets, and returns a response. Google Apps Script can serve both roles here — `doPost` webhooks for the SMS gateway, and `doGet`/HTML Service for the web app — which would keep everything in the free-Google-account family. Worth prototyping before assuming we need a separate hosted backend.

**Interface-specific:**
- **Web app (Phase 1a)** — Apps Script Web App / HTML Service: full week grid, horse usage/utilization at a glance, structured tap-to-select booking. No login, opens from a bookmarked link. Built first — see Section 4 for rationale. *Introduced to the pilot group on its own merits — no messaging about SMS coming later. Keep onboarding copy and trainer talking points free of "this is temporary" framing.*
- **SMS gateway (Phase 1b)** — e.g. Twilio: sends/receives the actual text messages. Layered in once the rules engine is validated via the web app.

**Important design principle carried over from your notes:** the LLM should handle language understanding and message drafting; the hard constraints (horse max saddle time, no-ride pairings, no double-booking, pricing rules) should be enforced in deterministic code, not trusted to the model's judgment. That holds regardless of which interface a user is on.

---

## 8. Sheet Schema (Google Sheets tabs)

Design principles first, since they shape every table below:
- **IDs, not names, are the relationships.** Every table gets a short prefixed ID (e.g. `STU-001`, `HOR-001`) generated by Apps Script, never typed by hand — names change, IDs don't.
- **Multi-select fields (riding styles, no-ride horses, etc.) are stored as comma-separated IDs within a cell**, not separate junction tabs. At this scale that's easier for a human to glance at if they ever open the Sheet directly, and Apps Script splits/joins them trivially.
- **Usage caps are computed, not stored.** A horse's minutes ridden today is calculated on demand by summing `Bookings`, not kept as a running total anywhere — a stored counter can drift out of sync with reality; a computed value can't.
- **A price and its components are stored, not computed — the deliberate exception to the rule above.** Every other derived value in this product is recalculated on read because a stored copy drifts. A price is the opposite case: it's a historical fact about a transaction, and *recomputing* it is what makes it drift. A lesson priced in March against March's bands and March's frequency tier must still read as $65 in September, after the bands were re-cut and the student's tier moved. So `Bookings` carries `base_price`, `band_adjustment`, `frequency_discount`, `offer_discount` and `manual_adjustment` as their own columns, with `price` as their sum. The components are what make the number explainable to the student a month later without reconstructing the config that produced it — the receipt is stored, not regenerated.
- **Every dollar amount lives on the lesson type; thresholds and windows are global.** A price band's *hours* (`Price_Bands`) and a frequency tier's *ride counts* (`Trainer_Config`) are set once and shared, because they're facts about the calendar and about a student, not about a product. Every amount they imply — the band premium, the tier discount, the gap-fill step — is a column on `Lesson_Types`, because what a busy Thursday hour is worth genuinely differs between a 30-minute lesson and a 90-minute one. This is why there is no pricing screen: pricing is entered where a lesson type is entered.
- **Price adjustments are whole dollars, never percentages.** Percentages force rounding, and rounding is exactly how a student ends up paying $60 one week and $65 the next with no explainable cause. With whole-dollar steps on a whole-dollar base, the no-cents rule holds by construction — there is no rounding rule anywhere in this product.
- **Calendar time and saddle time are tracked separately** (`duration_min` vs. `ride_time_min` on `Lesson_Types`). Scheduling/conflict checks use `duration_min`; horse usage-cap checks use `ride_time_min`. Conflating the two would either overbook the coach's day or misjudge how much a horse has actually been ridden.
- **`riding_styles` draws from one fixed, shared vocabulary** used identically by both `Horses` and `Students`, so the pairing check can do exact matching rather than fuzzy string comparison. **Revised down to `English, Western`** — the original six-option list (Dressage, Western Dressage, Hunter/Jumper, Trail Riding as separate entries) added distinctions that didn't earn their complexity; those now fold into whichever of the two base styles they're closest to.
- **A lesson's occurrence type (`recurring` / `adhoc` / `first_lesson`) and its horse assignment (dominant vs. substitute) are two genuinely separate concepts, not one field with three-plus values.** Earlier drafts of this doc treated "substitute" as a fourth occurrence type alongside recurring/ad hoc — that conflated "why does this lesson exist" with "which horse ended up on it," and broke down as soon as a recurring lesson's dominant horse went inactive: the lesson was still recurring, it just needed a different horse. Corrected model: occurrence type is derived from `recurring_id` + `lesson_type_id` alone (no `recurring_id` + first-time lesson type → `first_lesson`; no `recurring_id` otherwise → `adhoc`; has `recurring_id` → `recurring`). Horse assignment is derived separately by comparing a `Bookings` row's `horse_id` against its `recurring_id`'s `Recurring_Bookings.horse_id`: match → riding its normal (dominant) horse; mismatch → substitute, and the dominant horse is still shown for reference; no `recurring_id` → the concept doesn't apply. A recurring lesson whose dominant horse is inactive and has no substitute assigned yet is flagged `needs_substitute` — a third, independent flag on top of the other two, not a fourth type value.
- **Student/parent login is full name + phone number, not a password.** A deliberate simplicity choice, not an oversight — this app doesn't hold sensitive data, so a real auth system would add friction without meaningfully improving security. On return visits, the same name+phone pair looks up the existing `Students` row. For a minor, the name is still the student's own name (that's who the coach's roster is about), but the phone is the guardian's — since the guardian is who's actually operating the account. A nice side effect: this naturally supports multiple children under one family phone number without any extra design, since each child's login is their own distinct name paired with the same shared phone.
- **`Message_Log` isn't needed until SMS (Phase 1b)** — including it now avoids a schema migration later, but it can stay empty until then. **`Offers` is different: it's written from Phase 1a**, since the coach can notify a student about an open slot from day one; F4 later populates its remaining columns rather than getting a tab of its own.

### Tab: `Trainer_Config` (single row)
*`business_priority` (margin/volume/service) removed — deferred to Phase 2, it added complexity beyond what Phase 1a needs to prove out.*

| Field | Notes |
|---|---|
| scheduling_preference | back_to_back / spaced |
| min_buffer_min | Always enforced between any two lessons, regardless of preference. |
| max_buffer_min | Only affects what times get *offered* to students, and only when `scheduling_preference` is back_to_back — caps how tightly a suggested day gets packed before a bigger break is required. Irrelevant when `spaced`: spaced scheduling isn't trying to pack lessons tightly in the first place, so there's nothing for a maximum to prevent. |
| max_back_to_back | Max consecutive lessons before a break is required, independent of the buffer settings — even a back-to-back-preferring coach may want a hard ceiling on how many lessons run in a row. |
| late_cancel_hours | Notice a student must give for a cancellation to be non-billable. Cancel with less warning and the lesson is still charged. Hours, not days, because the boundary that matters is "later today" vs. "tomorrow morning" — a day-granular value can't tell those apart. The single input behind the student's one cancel button (Section 13). |
| prioritization_rule | e.g. "flex_for_8plus_rides_per_month". **Shares its threshold with `frequency_tier_1_min_rides` below** rather than carrying its own number — "frequent rider" has one definition across scheduling flex and pricing, or the coach ends up explaining why a student gets the flexible treatment but not the discount. |
| frequency_tier_1_min_rides | Billable rides in a calendar month that earn tier 1, e.g. 8. Blank switches frequency pricing off entirely. |
| frequency_tier_2_min_rides | Same for tier 2, e.g. 12. Must exceed tier 1. Blank means only one tier. |

*Two fixed tier columns rather than a `Frequency_Tiers` tab, deliberately: the design caps frequency pricing at two tiers, and a tab would invite a fifth. Two tiers a coach can state out loud ("8 rides a month and it's $5 off, 12 and it's $10") is the whole point; a ladder nobody can recite is the confusion this was meant to avoid.*

### Tab: `Trainer_Availability`
*Flat list of windows, not one row per day — a day can have zero, one, or several (e.g. Mon 8am-12pm AND Mon 3pm-8pm for a split shift), rather than assuming one continuous block per day.*

| Field | Notes |
|---|---|
| availability_id | e.g. `AVAIL-001` |
| day_of_week | Mon–Sun |
| start_time | — |
| end_time | — |

### Tab: `Trainer_Time_Off`
*A separate overlay on top of the recurring `Trainer_Availability` pattern — e.g. a two-day vacation — rather than editing the pattern itself. Any existing `Bookings` row whose date falls inside an active block is flagged `needs_rescheduling`; unlike a horse going inactive, there's no substitute-coach concept, so resolution is always manual (the coach reschedules or cancels via Booking detail).*

| Field | Notes |
|---|---|
| time_off_id | e.g. `OFF-001` |
| start_date | — |
| end_date | — |
| reason | optional free text, e.g. "Vacation" |

### Tab: `Disclosures`
*A **single current record**, edited in place. One row, not a history.*

| Field | Notes |
|---|---|
| sections | The seven sections, each with a stable `key`, a `title`, a `body`, and **`included`**. Keys are stable so a section keeps its identity across rewrites — a coach who puts "Risk of injury" into her own voice hasn't created a different section |
| — *(`included`, per section)* | Y/N. **Include / don't-include is per section, not global.** A coach who wants payment terms and horse welfare but not a liability waiver switches one off; a coach who wants no agreements at all switches them all off. An excluded section isn't hidden from riders — it isn't part of the terms, doesn't appear anywhere on their side, and isn't something they can be said to have agreed to |
| updated_at | When the terms last changed. Load-bearing rather than decorative — it's the line every "since the terms changed" comparison is drawn against |
| update_note | Coach-authored, required on every save. Riders see it, and telling them what changed is itself one of the terms, so the save is blocked without it |
| first_published_at | Informational |

*The seventh section, **"These terms can change"**, is what makes editing-in-place sound. It states that the coach may change the terms at any time including after signature, that the current version is always the one that applies and is always available in-app, that the coach will notify, that **scheduling, attending or keeping a lesson after a change is acceptance of it**, and that a rider who doesn't accept should stop scheduling and say so. It gets its own heading and its own tick rather than being a clause inside the waiver, because it is the term that governs all the others and a rider agreeing to it should have to notice it. The coach's editor carries a warning against weakening it.*

### Tab: `Disclosure_Acceptances`
| Field | Notes |
|---|---|
| acceptance_id | — |
| student_id | FK → `Students` |
| accepted_at | — |
| signed_name | The name as entered on the profile at the moment of signing, since a rider can rename themselves later and the signature should read as given |

*One row per rider, written when they create their profile. **There is nothing to re-sign** — no version to point at, and no re-acceptance flow. What keeps a rider current is continuing to book under the terms in force.*

*There is **no master `require_disclosures` switch**. It existed briefly and was removed when inclusion moved to the section: two controls that both mean "collect nothing" can disagree, and then the coach's screen and the rider's screen give different answers about what was agreed. "Collect nothing" is now simply the state where no section is included, which the coach's screen states in those words. Switching sections off **never erases a signature already given** — the Agreements tab still shows a rider when they signed.*

*`Bookings.created_at` was added for this feature: when the row was made, as distinct from `date`, when the lesson happens. It's what makes "scheduled after the terms changed" answerable — a lesson booked last month for next week accepts last month's terms, not this week's. Without it, acceptance-by-scheduling would be an assertion neither side could check.*

### Tab: `Price_Bands`
*Named time windows where the coach charges differently — the "some lesson times are more desirable" case. **Windows only; no amount lives here.** What a band is worth is a column on `Lesson_Types`, since a $10 after-school premium that's right for a 60-minute private is wrong for a 30-minute one.*

*Two constraints the editor enforces, both about keeping a price unambiguous:*
- ***Bands may not overlap each other.*** *A time falls in exactly zero or one band. Overlapping bands mean two possible prices for one slot, which is the exact failure this design exists to prevent — worse than having no bands at all, because it looks deliberate.*
- ***Three bands maximum.*** *Past three, neither the coach nor the student can hold the pricing in their head, and a pricing rule that can't be recited isn't transparent no matter how visible it is.*

*A time in no band simply carries the lesson type's `base_price` — "no band" is the normal case, not an omission.*

| Field | Notes |
|---|---|
| band_id | e.g. `BAND-001` |
| name | Coach-authored and student-visible, e.g. "After school", "Weekday mornings". This is the word that appears on the student's receipt line, so it has to read as a reason rather than a code |
| day_of_week | Mon–Sun. Flat list like `Trainer_Availability`, not one row per day — an "After school" band spanning Mon–Fri is five rows sharing a name |
| start_time, end_time | Entered through the same picker as every other time in the product |

*A band applies when a lesson's `start_time` falls inside the window. Matched on start time alone, not on overlap: a 60-minute lesson beginning at 2:45pm against a 3–6pm band is a 2:45 lesson, and pricing it as premium because it runs into the band would surprise the person who booked the earlier slot on purpose.*

### Tab: `Lesson_Types`
| Field | Notes |
|---|---|
| lesson_type_id | e.g. `LES-001` |
| name | e.g. "60-min adult private" |
| duration_min | Total slot length — what blocks the coach's calendar (e.g. 60). Includes prep and put-away time. |
| ride_time_min | Actual time the horse is under saddle (e.g. 45). This is what counts against a horse's daily usage cap, *not* `duration_min` — otherwise prep/put-away time would silently eat into the horse's ride-time budget. |
| is_group | Y/N |
| max_group_size | if group |
| is_intro | Y/N, and **exactly one type carries it**. Marks the type a brand-new rider is offered before recurring and open lessons are unlocked. A *role*, deliberately, not an id: the prototype originally matched the literal string `"first-time"` in eleven places, which works only because seed ids are fixed — a real coach's types have generated ids, and every one of those comparisons silently becomes false. Setting it on one type clears it from the others on save rather than erroring, since the coach's most recent choice is the one she meant. With none set, new riders have nothing to book, so the Lessons screen says so at the top |
| base_price | **Renamed from `target_price`.** Whole number. The anchor every adjustment is applied to, not a target the final price drifts around — the rename is the point: with bands and discounts doing the varying, a "target" implies a middle the system aims for, which it no longer does |
| min_price | Whole number. A hard floor: after every adjustment stacks, the price is clamped here. The clamp is **surfaced, never silent** (Section 10) |
| max_price | Whole number. Now a ceiling on **manual overrides only** — the computed price can't exceed it either, but band adjustments are the coach's own configuration, so a band that would breach the ceiling is rejected on Lessons rather than clamped at booking time |
| band_adjustments | nullable, comma-separated `band_id:amount` pairs, e.g. `BAND-001:10,BAND-002:-5`, following the same store-multi-values-in-a-cell principle as `riding_styles`. Whole dollars, signed — a band can discount as easily as it can premium. A band absent from the list contributes 0, so a coach who only prices one of their bands differently for this type writes one pair |
| frequency_discount_1 / frequency_discount_2 | nullable whole numbers, e.g. 5 and 10 — what a tier-1 and tier-2 student saves **on this type**. Blank means this type isn't discounted by frequency at all, which is a real case: a coach may reward volume on regular lessons and not on an intro |
| gap_fill_discount | nullable whole number — the preset the coach's notify sheet offers with one tap when filling an open slot (Section 11). Not a cap: the sheet allows a custom amount, still floored by `min_price`. Blank means the sheet opens with no preset and requires a typed amount |
| restricted_horse_ids | nullable, comma-separated FK → `Horses`. If set, only these horses are eligible for this lesson type (still subject to normal pairing checks) — e.g. a "first time student" lesson type might restrict to a smaller, extra-gentle pool for an initial assessment, even if general pairing would allow more. Empty means no restriction beyond normal pairing. |
| potential_lesson_eligible | Y/N — whether open windows that fit this type are surfaced as potential lessons for the coach to offer. Defaults Y for a new non-group type; **forced N and not editable when `is_group`** (see Section 10). A coach may switch it off for types that make no sense as gap-fills — an intro lesson is for a brand-new student, not a slot an existing student fills. |
| riding_styles | nullable, comma-separated, from the controlled vocabulary. If set, both the assigned horse *and* the student must support at least one listed style — e.g. a Western-only lesson type shouldn't be bookable by an English-only student even on a horse that does both. Empty means no restriction. |

### Tab: `Horses`
| Field | Notes |
|---|---|
| horse_id | e.g. `HOR-001` |
| name | — |
| min_experience_level | beginner / intermediate / advanced — student's `experience_level` must be at or above this (ordinal: beginner < intermediate < advanced) to be a match |
| adult_only | Y/N — matched against student `age` >= 18 (same cutoff used for SMS routing, so "adult" is a single consistent definition across the whole system) |
| riding_styles | comma-separated, from the controlled vocabulary above |
| max_rider_weight_lbs | matched against student's `weight` as a hard safety cap |
| rest_days_per_week | e.g. 1 |
| max_daily_minutes_adult | e.g. 120 |
| max_daily_minutes_overall | e.g. 180 — the hard ceiling regardless of rider type |
| active | Y/N — lets the trainer take a horse fully offline (e.g. lame) without deleting history |
| notes | — |

### Tab: `Students`
*`favorite_horse_ids` was removed. It was student-declared, purely informational, and read by nothing — no rules-engine check and no tiebreak in horse assignment. Replaced by **year-to-date ride counts derived from `Bookings`** (Section 10), which answer the same underlying question — which horses does this student actually ride — from what happened rather than from what they once said. Nothing is stored: a stored tally drifts the first time a lesson is retroactively marked no-show.*

*SMS routing rule: if `age` < 18, all SMS communication goes to `guardian_phone`; if 18+, directly to `phone`. Computed at send-time from `age`, not stored separately — so it stays correct automatically as a student ages past 18, with no manual update needed.*

***Frequency tier recompute rule** — runs once, on the 1st of each month, for every approved student:*
1. *For each of the **two most recently completed calendar months**, count that student's **billable** `Bookings` rows (`is_billable` = Y). Billable rather than ridden, deliberately: a late cancel or no-show was paid for, and docking someone's rate for a lesson they were charged for is the kind of unfairness that gets noticed.*
2. *The tier is the **better of the two months'** earned tiers. This one line is the entire ratchet: a good month raises the rate immediately, a bad month can't lower it until it's been bad twice. A student who misses a week to flu doesn't open the app to a price rise, and the coach never has to explain one.*
3. *A tier change writes a `Student_Alerts` row (`rate_changed`, Section 13) — including a drop, which is the case that would otherwise be discovered at the till.*

*Calendar months rather than a rolling 30-day window, because "in July you rode nine times" is a sentence a coach and student can both check. A rolling window's start date is a number nobody can name, and an unexplainable rule is an untransparent one however correct its arithmetic.*

| Field | Notes |
|---|---|
| student_id | e.g. `STU-001` |
| name, phone, email | — |
| guardian_name, guardian_phone, guardian_email | `guardian_name` and `guardian_phone` are **required when `age` < 18** and collected on the profile form; `guardian_email` is not collected yet. |
| guardian_relationship | e.g. Parent, Grandparent, Legal Guardian, Other — collected alongside guardian_name when the student is under 18 (Section 13) |
| emergency_contact_name, emergency_contact_phone | **Required on every profile**, whatever the age — a profile can't be created or approved without one (Section 9). |
| age | — |
| experience_level | beginner / intermediate / advanced |
| riding_styles | comma-separated, from the controlled vocabulary (see design principles above) |
| weight | — matched against a horse's `max_rider_weight_lbs` as a hard safety cap |
| target_riding_times | comma-separated list of day+time windows — no cap on how many; more target times means more opportunities matched at full price, not just one preferred slot |
| potential_riding_times | comma-separated, same format — times the student would take *if it fills a gap*, distinct from target: this is what makes it worth pairing with a discount (see `find_matching_open_slots_for_student`, Section 10) |
| notification_preference | target_only / target_and_potential / all. **`all` is specified but not yet wired**: both consumers (`find_matching_open_slots_for_student` and the coach's notify candidates) drop a student whose windows don't cover the slot before the preference is read, so `all` currently behaves as `target_and_potential`. Wiring it needs a third `kind` beyond target/potential, which the notify screen sorts and groups by — and a decision about whether "any open time" is a preference worth having, since it makes every approved student a candidate for every open slot. |
| frequency_tier | 0 / 1 / 2 — **stored, not derived**, and the reason is the whole point of the mechanism: a tier recomputed on every read would move mid-month as the student's rolling count wobbled, which is precisely the "$60 last week, $65 this week" confusion this design exists to prevent. Held steady for a month at a time, changed by one job, on a date the student can name |
| frequency_tier_effective_month | The month the current tier took effect, e.g. `2026-08`. Lets the student's own screens say *when* their rate changed rather than only what it is, and lets a monthly job tell "already run" from "not yet run" without a separate flag |
| no_ride_horse_ids | comma-separated `HOR-` IDs — editable by student *and* trainer |
| notes | free text |
| profile_status | pending_review / approved — a self-created profile starts `pending_review`; the trainer reviewing/accepting it (F1) sets it to `approved`. A profile the coach creates themselves (Section 11 item 4) starts `approved` — they're the reviewer, so their own entry doesn't route into their own queue. Distinct from `active`, which is about currently taking lessons, not profile completeness. |
| recurring_potential_unlocked | Y/N, default N — gates the potential-lessons section and recurring-schedule management on the student's own profile page (Section 13). Deliberately *not* auto-set just because the intro lesson's status becomes `completed`; the trainer takes an explicit action to open it (F2's next step after the intro lesson). That coach-side trigger flow is deferred — this field just needs to exist so the gate is real. |
| active | Y/N |

### Tab: `Student_Notes`
*General-purpose escalation from student/parent to coach — `category` keeps it extensible beyond the intro-lesson case, rather than needing a new tab per scenario. That extensibility is now load-bearing: the student's free-form "Message your coach" (Section 13) writes here too, so one queue holds everything a student has raised, whatever prompted it.*

| Field | Notes |
|---|---|
| note_id | e.g. `NOTE-001` |
| student_id | FK → `Students` |
| category | `intro_lesson_no_fit` / `recurring_lesson_no_fit` / `message` — the first two are raised from a specific dead end, the third is unprompted. The coach-facing label for each is defined in one place, so a new category can't silently inherit another's wording. |
| note | student's free text |
| status | open / resolved — the coach clears a note from their own queue on Student profile; nothing else writes `resolved`. |
| created_at | — |

### Tab: `Student_Alerts`

*The one place in Phase 1a where "derive, don't store" doesn't apply, and worth being explicit about why: an alert records **who did what, when**, and the actor is precisely what current state can't recover. A booking with status `late_cancel` looks identical whether the coach or the student cancelled it — and a student must not be alerted about their own action. `no_ride_horse_ids` changes leave no trace at all once overwritten. So this is an append-only event log, written at the moment a coach acts, never edited except to mark seen.*

*Retention is **7 days**, and expiry is a read filter, not a delete — an alert older than the window simply stops being visible. In Sheets a nightly cleanup can prune the tab; nothing depends on it having run.*

| Field | Notes |
|---|---|
| alert_id | e.g. `SAL-001` |
| student_id | FK → `Students` |
| kind | see the table in Section 13. Determines the heading and the colour; the row itself carries no styling |
| detail | the specific change, in the student's terms — the date, time, horse and amount as applicable |
| created_at | drives both ordering (newest first) and expiry |
| seen | Y/N — set when the student opens the Alerts tab. Drives the unread count and the new-item highlight, nothing else. Never set back to N |

### Tab: `Horse_Inactive_Periods`
*Created when a coach marks a horse inactive. Separate from the simple `active` Y/N flag on `Horses` — this tracks the *period* itself (with an estimate the coach can set/adjust) so the substitution screen has a window to plan coverage against.*

| Field | Notes |
|---|---|
| period_id | e.g. `INA-001` |
| horse_id | FK → `Horses` |
| start_date | when marked inactive |
| estimated_end_date | coach's estimate; editable as the situation changes, nullable if genuinely unknown |
| actual_end_date | nullable — set automatically when the coach marks the horse active again |
| status | active / ended |
| reason | optional free text, e.g. "lame" |

### Tab: `Substitution_Assignments`
*The coach's confirmed (or system-recommended, pending) substitute choice. For a recurring lesson, one row covers every occurrence for the rest of the inactive period — set on `recurring_id`, not per date. For an ad hoc lesson caught in the window, it's a one-off decision — set on `booking_id` instead. Exactly one of the two is set per row.*

| Field | Notes |
|---|---|
| assignment_id | e.g. `SUB-001` |
| period_id | FK → `Horse_Inactive_Periods` |
| recurring_id | nullable FK → `Recurring_Bookings` |
| booking_id | nullable FK → `Bookings` |
| substitute_horse_id | FK → `Horses` |
| confirmed | Y/N — system recommendations start N, become Y when the coach taps confirm |
| created_at | — |

*Bookings generation logic: when a `Bookings` row would be generated for a date that falls within an active `Horse_Inactive_Periods` window for the pattern's normal horse, check `Substitution_Assignments` for a confirmed match on that `recurring_id`. If found, generate the row with `horse_id` set to `substitute_horse_id` (which the earlier booking-type rule then correctly reads as "Substitute"). If not found, the occurrence is unresolved — surfaced on the screen below for the coach to decide.*

### Tab: `Recurring_Bookings`
*Source of truth for a student's standing weekly pattern with a horse (F2). Individual `Bookings` rows are generated from this each week; canceling one occurrence only touches that `Bookings` row, while ending the whole series happens here via `status`.*

| Field | Notes |
|---|---|
| recurring_id | e.g. `REC-001` |
| student_id | FK → `Students` |
| horse_id | FK → `Horses` |
| lesson_type_id | FK → `Lesson_Types` |
| day_of_week | Mon–Sun |
| start_time | — |
| status | active / ended |
| start_date | when the pattern began |
| — *(no price field)* | Deliberately absent. A pattern's price isn't one number: its `base_price` and `band_adjustment` are fixed by the slot and stable across every occurrence, but its `frequency_discount` moves with the student's tier. Storing a pattern price would mean either freezing the discount (so a student who earns tier 2 keeps paying tier-1 rates on their standing lesson — the one lesson the reward was meant for) or letting a stored value silently disagree with the rows it generated. Occurrences carry the components; the pattern carries none. |
| end_date | nullable — set when the pattern ends |
| notes | — |

### Tab: `Bookings`
*Generation: each active `Recurring_Bookings` pattern keeps a rolling 4-week horizon of rows here, extended nightly by an Apps Script trigger (Section 9). Generation runs the full rules engine per row and creates-and-flags on conflict rather than skipping.*
*Billing implication: `no_show` (confirmed lesson, student didn't attend) and `late_cancel` (cancelled inside the `Trainer_Config.late_cancel_hours` notice window) are both billable at the full `price`. `early_cancel` (cancelled before that window) is not billable. The threshold is the coach's setting, not a fixed 24 hours. Rather than zeroing out `price` for non-billable rows, `is_billable` carries the charge decision as its own field — so `price` always shows what the lesson would have cost, preserving the record for reporting on cancellation patterns or revenue lost to no-shows.*

| Field | Notes |
|---|---|
| lesson_id | e.g. `BKG-00001` |
| recurring_id | nullable FK → `Recurring_Bookings` — set only if this row was generated from a standing pattern; ad hoc bookings leave this blank |
| student_id | FK → `Students` |
| horse_id | FK → `Horses` |
| lesson_type_id | FK → `Lesson_Types` |
| date, start_time | End time is **derived** from `Lesson_Types.duration_min`, not stored: a stored copy can drift the moment a lesson type's duration is edited, the same reasoning as computed usage caps. |
| status | pending / confirmed / completed / no_show / late_cancel / early_cancel — see billing note below |
| base_price | Copied from `Lesson_Types.base_price` at creation, not read through by FK — the lesson type's price can be edited tomorrow and this lesson's history mustn't move with it |
| band_adjustment | Signed whole number, 0 when the start time falls in no band. Which band it came from is recoverable from the date/time, so the band name isn't duplicated here |
| frequency_discount | Whole number ≥ 0, stamped from the student's `frequency_tier` **at creation**, never re-read. A recurring occurrence generated in August carries August's tier even if it's ridden after a September recompute — the price the student was shown when the row appeared is the price they pay |
| offer_discount | Whole number ≥ 0. Non-zero **only** when this booking came from an accepted coach-initiated offer carrying a discount (Section 10). A student who finds the same open slot and books it themselves gets 0 here, by design |
| manual_adjustment | Signed whole number, 0 normally — the coach's override from Booking detail, and the reconciling term that keeps `price` equal to the sum of its parts. Without it an override would produce a receipt that doesn't add up, which is worse than no receipt |
| price | whole number — **the sum of the five columns above**, clamped to the lesson type's `min_price`/`max_price`. Always the lesson's normal price regardless of status; see `is_billable` for whether it's actually charged. Stored rather than summed on read for the same reason its parts are: a lesson type edited later must not silently reprice a lesson that already happened |
| is_billable | Y/N — derived from `status` when the row is created/updated (`confirmed`→pending outcome, `completed`/`no_show`/`late_cancel`→Y, `early_cancel`→N), but stored explicitly so the charge decision is never lost even if `status` rules change later or the row is reviewed after the fact |
| is_new_student | Y/N — drives the "flag new student" behavior in F5 |
| created_at, updated_at | — |
| notes | — |

### Tab: `Message_Log` *(populated starting Phase 1b)*
*Transport record — proof of what text actually went over the wire. Distinct from `Offers`, which records the scheduling fact that an offer was made: one message may carry several offers, and a Phase 1a offer is made with no message sent at all. When both exist, an outbound offer message writes a row in each.*
| Field | Notes |
|---|---|
| log_id | — |
| student_id | nullable (trainer-only messages) |
| channel | sms / web |
| direction | in / out |
| timestamp | — |
| message_text | — |
| related_lesson_id | nullable FK → `Bookings` |

### Tab: `Offers` *(written from Phase 1a; F4 fills the remaining columns in Phase 2)*
*One row per time a slot was offered to a student — whether the coach sent it by hand from Day view or Student profile (Phase 1a), or F4's automated fill-a-cancellation batch generated it (Phase 2). Deliberately **one tab, not two**: earlier drafts had a Phase 2-only `Waitlist_Offers` keyed on `lesson_id`, which would have left Phase 1a's manual notifications with nowhere to live and split "every time we offered this student something" across two places. The two cases differ only in what's being offered — a specific freed lesson (F4, so `lesson_id` is set) or an empty window (Phase 1a, so it isn't) — and in whether a reply can come back. Same concept, one home, matching the `no_ride_horse_ids` principle of a single source of truth per idea.*

*Phase 1a writes `offer_id`, `student_id`, `date`, `start_time`, `horse_id`, `kind`, `offered_at` and leaves the rest empty. **Whether the offer converted is derived, not stored** — a `Bookings` row for that student at that date and time means it did — because Phase 1a has no channel for a student to reply through. `response` and `rank` stay empty until F4 gives them meaning.*

| Field | Notes |
|---|---|
| offer_id | e.g. `OFR-001` |
| student_id | FK → `Students` — who it was offered to |
| date, start_time | The slot offered. Populated in every case, including F4's, so the tab is queryable by time without joining out to `Bookings` |
| horse_id | FK → `Horses` — the horse that made this student eligible for the slot |
| lesson_type_id | FK → `Lesson_Types` — which type the offer was for. A window can fit more than one, so the offer names the one this student was matched on |
| lesson_id | nullable FK → `Bookings` — set only when the offer is a specific freed lesson (F4). Empty for a Phase 1a gap-fill offer, since no booking exists for an open window |
| kind | target / potential — which of the student's windows the slot matched **at the moment of the offer**. Not derivable later: the student can edit their windows, and a `potential` match is precisely the discount case (Section 10), so this is what tells us later whether the potential-times concept actually filled gaps |
| offer_discount | nullable whole number ≥ 0 — the discount the coach attached when sending this offer, or empty for a full-price offer. This is what makes `kind` (below) finally load-bearing rather than analytical: a `potential` offer is the discount case, and the amount agreed at the moment of the offer is what has to land on the `Bookings` row if the student takes it. Without it the discount lives only in the sent message, and the booking prices itself at full rate |
| offer_reason | nullable free text, e.g. "filling a gap" — the coach's own words, carried into the outbound message and onto the booking's `notes` on acceptance. A discount whose reason isn't captured at the moment it's given gets reconstructed later, badly |
| offered_at | — |
| response | nullable — accepted / declined / no_response. Empty in Phase 1a: there's no reply channel yet |
| rank | the student's position in the ranked list when the batch was sent — 1 is the strongest match. **Populated from Phase 1a**, not just F4: the coach's notify screen sends a batch too, so the ordering it acted on is worth keeping. Empty only for a one-at-a-time offer made from a Student profile |

*The primary Phase 1a query this exists to answer: "have we already offered this student this slot?" — `student_id` + `date` + `start_time`, so the same 9am Thursday doesn't get pushed at Maya three days running. Without persistence this lived in browser memory and vanished on refresh.*

---

## 9. Decisions Log

Decisions made deliberately, with the reasoning that produced them, so a later reader (or a later us) can tell a considered choice from an accident. Each is reflected in the sections it affects; this is the index, not the specification.

**Student alerts are an event log, not a derivation — the only such case in Phase 1a.** Every other "what should we show" question in this product is answered from current state, deliberately. Student alerts can't be: the thing being reported is an action and its actor, and state doesn't remember either. A cancelled booking looks the same whichever side cancelled it. Considered and rejected: deriving alerts by diffing state, which needs a stored prior snapshot — strictly more storage than an append-only log, and it would still have no way to attribute the change.

**Student alerts are informational only — never an approval gate.** The coach owns the schedule. A change that waited on student acknowledgement would leave the barn's real state ambiguous until they next opened the app, and would make the coach's own screens untrustworthy. Retention is 7 days because an alert's purpose expires: after a week the change is either lived through or visible in the schedule itself. Expiry is a read filter rather than a delete, so nothing breaks if a cleanup job hasn't run.

**Four alert triggers were added beyond the initial six.** Lesson moved, recurring pattern changed, recurring series ended, and no-show marked. The test applied: does the coach's action change something the student would otherwise discover by turning up, or be billed for without warning? A rescheduled lesson fails that test loudly — arguably more urgently than a cancellation, since a student who misses the change arrives to an empty arena. Price adjustment was included on the billing half of the same test.

**Favorite horses replaced by year-to-date ride counts.** `favorite_horse_ids` was student-declared, informational, and read by nothing — no rules-engine check, no tiebreak in horse assignment, not even a sort order. Designing an editor for it forced the question of what it was *for*, and the honest answer was: to tell the coach which horses this student rides. Ride counts derived from `Bookings` answer that from what actually happened, need no maintenance, and can't go stale. Considered and rejected: keeping the field and giving it teeth by feeding it into horse assignment — that would have made a student's stated preference compete with safety and welfare rules, which is exactly the wrong place for a soft signal.

**Students cancel; they never choose which kind of cancel.** The student gets one button, and `cancel_disposition` decides from lead time whether it's an `early_cancel` or a `late_cancel`. Showing both would present a billing consequence as a preference. The button disappears entirely once a lesson has started, because the difference between a no-show and a late cancel at that point is a judgement about what happened, and only the coach was there. The threshold lives in `Trainer_Config.late_cancel_hours` rather than hardcoded at 24, since barns differ. Considered and rejected: letting students cancel a started lesson as a late cancel — the billing outcome is identical, but it lets a student pre-empt the coach's record of a no-show.

**Cancellation is measured in hours to start time, not days to date.** The rule a coach actually states is "24 hours' notice," and the boundary that matters most — a lesson later today versus one tomorrow morning — is invisible at day granularity. Both would read as "not yet." This is the one place in Phase 1a where a date alone isn't enough.

**Student navigation is four tabs, not one scrolling home.** A student with three weekly lessons has a rolling four-week horizon of twelve occurrences plus matched openings, recurring patterns, ride counts and profile fields — unreadable as one page on a phone. Split into **Home** (this week, and what needs a decision now), **Future** (rolling four weeks, plus the recurring patterns that generate them), **Past** (history), and **Profile**. Home is deliberately the current calendar week rather than a rolling seven days: rolling would overlap Future by a week, and Home's job is "what am I doing now," not a second copy of the look-ahead.

**Recurring-pattern management lives on Future, not Home.** Changing a pattern affects every future week; cancelling an occurrence affects one. Putting them on the same screen invites confusing the two, and the individual cancel buttons added to lesson rows made that risk concrete. The Future tab states the distinction in words as well as by placement.

**Substitutions unwind when the horse returns.** Marking a horse active again closes its `Horse_Inactive_Periods` row and returns future occurrences to the dominant horse — but only those that still pass the rules engine against the returning horse, since the schedule may have shifted while it was out. Anything that can't cleanly go back stays on its substitute. What moved back is announced on Alerts as informational, because the coach may have told the student otherwise in person and there is no outbound messaging in Phase 1a to correct it. Considered and rejected: leaving substitutions standing until manually undone, which quietly converts a temporary arrangement into a permanent one.

**Recurring occurrences exist on a rolling 4-week horizon**, extended nightly by an Apps Script trigger. Matches the 4-occurrence lookahead `find_recurring_lesson_options` already validates against, so what the student was promised at booking time is exactly what gets generated. Generation runs the rules engine per row rather than stamping rows out blindly — a time-off block or an inactive horse added today only catches the occurrences that already exist, so anything generated afterward would otherwise land silently inside it. Conflicts **create-and-flag** rather than skip: an occurrence with a visible problem is recoverable, an occurrence that silently never existed is not.

**A pattern edit only rewrites occurrences that still match the old pattern** — same horse, same start time, and an unmodified **pattern-level price**. *Revised with the pricing model:* "unmodified price" used to mean the occurrence's final `price` matched its siblings', which breaks the moment a frequency tier changes mid-series and reprices the occurrences generated after it — every one of them would read as individually edited and be left behind by the next pattern edit. The comparison is now on `base_price + band_adjustment`, the part of the price the pattern actually determines. `frequency_discount` varies legitimately across a series and `offer_discount` can't appear in one at all; only a non-zero `manual_adjustment` marks an occurrence as deliberately touched. Anything individually changed is left alone, the same rule "change dominant horse" already follows: a per-occurrence decision was a deliberate act and shouldn't be undone by a later pattern-level one. A skipped occurrence keeps its old day and time, which means it no longer matches its `recurring_id`'s day/time — the existing derivation therefore reads it as ad hoc, which is what it has effectively become. It surfaces once on Alerts ("Maya's 8/25 Tuesday lesson stayed put when her weekly slot moved") so a stray lesson isn't discovered by accident.

**Group lessons relax exactly one half of check #6** (see Section 10). No new field: a group is derived from bookings sharing `lesson_type_id` + date + `start_time`.

**Single-level Undo ships in Phase 1a.** Not just a testing convenience — End series, Mark cancel and Mark inactive are all one tap with real consequences, and a coach working one-handed at the barn will mistap. Three constraints came with the decision: (a) undo reverses **the rows that action wrote**, restoring their prior values, never a whole-state snapshot — a student can book from their own device between the action and the undo, and a state restore would silently erase them; (b) it expires at the next data-changing action or the end of the session, keeping the stale window small; (c) it can't unsend — once Phase 1b messaging exists, actions that have already texted someone either confirm before sending or drop out of undo scope, to be settled when the SMS layer is designed.

**Emergency contact is required on every profile; guardian name, relationship and phone are required under 18.** Previously both were schema fields no screen collected. A barn can't put someone on a horse without a number to call, and an incomplete profile is worse than an absent one because it looks finished. One completeness rule is shared by the student's form and the coach's review screen — the coach can't approve a profile that a student couldn't have submitted. For a minor the guardian's phone defaults to the number the account was created with, since the guardian is who operates the account, and stays editable for a guardian who wants messages elsewhere; `Students` SMS routing (Section 8) then sends to `guardian_phone`.

**Lesson type names are advisory, not enforced.** "60-min adult private" and "45-min child private" describe what a type is for; no check binds them to a student's age. The real safety constraints live on the horse — `adult_only`, `min_experience_level`, `max_rider_weight_lbs` — and those hold no matter which type is booked, so an age rule on the type would guard a boundary that isn't a safety boundary. Considered and set aside: an `adult_only` flag on `Lesson_Types` mirroring the horse field. It's one small check, but it would harden a naming convention into a rule before there's evidence the convention needs one, and a coach who books a mature 16-year-old into the adult hour has made a reasonable call the system shouldn't override. **Reopens when a student self-books a type that clearly doesn't fit them** — the plausible path is the potential-lesson flow offering an adult type to a 17-year-old, since the coach isn't in the loop there. If that happens once in the pilot, add the flag.

**`Students.available_lesson_type_ids` is dropped from the schema.** It was carried from the v1 data model and consulted by no check in the rules engine, on any interface. What a student can book is already decided by `Lesson_Types.restricted_horse_ids` and `riding_styles` on one side and the student's own `experience_level`, `age`, `riding_styles`, `weight` and `no_ride_horse_ids` on the other — a per-student allow-list would be a fourth place the same answer could be expressed, and the first to fall out of sync. A field that exists but enforces nothing is worse than no field: it reads as a safety control while doing nothing. If a coach later needs to cap one student to specific lesson types, it comes back as a real check in Section 10 rather than as a column nothing reads.

**The coach decides which lesson types can fill a gap.** `potential_lesson_eligible` on `Lesson_Types`, defaulting Y for new non-group types and forced N for group types. Slot discovery previously assumed a 60-minute private for every open window, which meant the coach had no say in what got offered and short gaps that could only fit a 45-minute lesson went unseen. Now an open window surfaces only if some opted-in type fits it, with a horse that clears the rest-day and usage-cap checks.

**A slot is only worth offering if someone asked for that time.** A student appears on the notify screen only when the slot falls inside their own target or potential windows — the earlier "outside their windows" category is gone. Offering people times they never expressed interest in trains them to ignore the messages, which costs more than the occasional filled gap is worth. Where no student matches, the Day view shows text instead of a live button.

**Offer ordering is target-first, then by demonstrated acceptance.** Target above potential because a target offer is full price and a potential one is the discount case, so the cheaper fill is tried first. Within each band, students are ranked by accepted ÷ offered, smoothed `(accepted + 1) / (offered + 2)` so no-history students sit at a neutral 0.5 instead of last. Acceptance stays derived from `Bookings` rather than stored, consistent with the `Offers` decision below. Worth revisiting once there's real data: recency isn't weighted, so a student who said yes twice a year ago outranks one who said yes last week.

**The notify screen pre-selects the top five and sends as a batch.** Five is the batch the coach would almost always send; pre-selecting it means the common case is one tap, while everything below stays one tap away and any pre-selection can be removed. Because it's a batch, `rank` on `Offers` is populated from Phase 1a rather than waiting for F4.

**Offers get one tab, written from Phase 1a.** The coach's "notify eligible students" action creates a fact — *this student was offered this slot, on this horse, at this moment, matching this kind of window* — that previously lived only in browser memory, so it vanished on refresh and nothing stopped the same slot being pushed at the same student repeatedly. Rejected: logging it in `Message_Log`, which is a transport record shaped around `message_text` and a `related_lesson_id` that would sit empty (an offered gap has no `Bookings` row), burying the queryable facts in prose. Rejected: a separate `Outreach_Log` alongside F4's `Waitlist_Offers`, which would have split "everything we've ever offered this student" across two nearly identical tabs. Chosen: a single `Offers` tab that F4 grows into, with `lesson_id`, `response` and `rank` nullable and empty through Phase 1a. Conversion is derived from `Bookings`, not stored, since Phase 1a has no reply channel. `kind` (target/potential) is stored rather than recomputed because students edit their windows, and it's the field that will eventually tell us whether discounted potential-time offers actually fill gaps.

**Only a student or guardian creates a profile; the coach edits.** This reverses the earlier decision that a coach-created profile is approved on save — that decision is void because the coach can no longer create one at all. The reasoning: a profile now carries an emergency contact and, for a minor, guardian contact and relationship, and those are exactly the fields a coach would guess at or leave blank while a student stands in front of them. The person accountable for that information should be the one entering it. Every profile therefore starts `pending_review` and reaches `approved` through the coach's review screen, which is one path rather than two.

*The cost, stated plainly:* Phase 1a has no SMS intake, so a coach who meets a new rider at the barn can't type them in — they hand over the link and the rider fills it in on their own phone. That's friction on the one flow where the coach is standing right there, and it's the main thing to watch in the pilot. If it proves painful, the fix isn't coach-authored profiles but a coach-initiated invite that still lands the student in the form.

**`Trainer_Config.scheduling_preference` is a fixed two-value field** — back_to_back / spaced — not open-ended, now that the buffer and back-to-back-cap fields carry the more granular configuration.

**Dynamic pricing is three separate mechanisms, not one adjustable number.** The coach's three motivations — desirable hours are worth more, an empty day is worth discounting, frequent riders deserve rewarding — look like one problem and are three, distinguishable by what the adjustment attaches to and when it becomes knowable. A **band premium** attaches to the *slot*: uniform for everyone, published indefinitely in advance. A **frequency discount** attaches to the *student*: a rate they hold, changing on a stated date. A **gap-fill discount** attaches to the *offer*: one-time, coach-initiated, reason attached. Kept separate they're three sentences a coach can say out loud; blended into one computed number they're the "$60 last week, $65 this week" confusion that motivated the work in the first place. Considered and rejected: a single `price_multiplier` per booking with the reasoning in `notes`, which is fewer columns and no way to answer "why" without reading prose.

**Whole dollars, never percentages.** The requirement was whole-number prices with no cents. A percentage model meets it only by adding a rounding rule, and every rounding rule produces neighbouring prices that differ for reasons no one can see — 10% off $65 and off $60 is $58.50 and $54, and whichever way those round, one of the two students has a question. Whole-dollar adjustments on a whole-dollar base satisfy the no-cents rule by construction; there is no rounding step anywhere in Phase 1a.

**Windows and thresholds are global; every amount is per lesson type.** A price band's hours and a frequency tier's ride count are set once, on Lessons, because they're facts about the calendar and about a student. What either is *worth* is a column on `Lesson_Types`, because a flat $10 after-school premium is right for a 60-minute private and wrong for a 30-minute kids' lesson, and a coach forced to choose one number for both will pick the one that's wrong somewhere. This is also why there is no Pricing screen: pricing is entered where a lesson type is entered, at the moment the coach is already deciding what that lesson is. Considered and rejected: global amounts, which halve the configuration and reintroduce exactly the proportionality problem the coach would notice first.

**Automatic demand-responsive pricing was rejected outright.** Pricing that falls as a day stays empty (or rises as it fills) is the obvious reading of "some days the coach may be willing to discount," and it's the one mechanism here that can't be made transparent: the price moves on inputs the student can neither see nor predict, so no explanation exists that isn't "the system decided." The coach-initiated gap-fill offer reaches the same outcome — empty slot, filled, at a discount — with a nameable cause. **Reopens if pilot coaches are found sending the same discount to the same students week after week**, which would mean the manual step is ceremony around a rule that already exists.

**A gap-fill discount is unreachable by self-booking, deliberately.** A student who finds the same open slot on their own Home tab and books it pays full price; only an accepted coach-sent offer carries `offer_discount`. This reads as arbitrary and is load-bearing: a discount obtainable by waiting isn't an incentive to fill a gap, it's a general price cut that teaches every student to stop booking at full rate, and it would quietly undo the coach's margin while looking like generosity. The coach choosing to offer it is the thing being paid for.

**A price and its components are stored, against this product's usual rule.** Everything else derived — usage caps, ride counts, completion, offer acceptance — is computed on read, because stored copies drift. A price inverts it: *recomputing* is what makes it drift, since the bands and tiers underneath it will have moved by the time anyone asks. `Bookings` therefore carries five component columns plus their sum, which also means the receipt a student is shown is the receipt that was stored rather than one reconstructed from today's configuration. Considered and rejected: storing only the total with the reasoning in `notes`, which answers "how much" but not "why," and can't be summed to tell the coach what a month of discounts actually cost her.

**The frequency tier is stored and moves once a month, not per booking.** A tier recomputed on read would drift with the student's rolling count mid-month, which is the precise failure the model was built to avoid — the discount meant to reward consistency would itself be the source of unpredictable prices. Recomputed on the 1st, applied forward, never retroactively. The tier is the **better of the last two completed calendar months**, which is the whole ratchet in one line: a good month raises the rate immediately, a bad month can't lower it until it's been bad twice, and no student opens the app to an unexplained price rise after a week off sick. Counted on **billable** rides rather than ridden ones, so a lesson someone paid for still counts toward their rate. Considered and rejected: a rolling 30-day window, which is marginally fairer and has a start date nobody can name — and an unstatable rule is an untransparent one however good its arithmetic.

**Frequency pricing tells the student what the next tier needs.** The coach's stated goal was to *encourage* more riding, not only to reward it; a discount the student can't see themselves approaching does the second and not the first, at identical cost. The Profile tab therefore shows the current rate with its cause and date, and the gap to the next tier as a target against this month's count so far.

**One definition of "frequent rider."** `Trainer_Config.prioritization_rule` already carried an 8-rides-a-month threshold for scheduling flexibility; `frequency_tier_1_min_rides` shares it rather than introducing a second number. Two thresholds would eventually disagree, and a coach explaining why a student gets the flexible treatment but not the discount has no good answer available.

**Setup was split into Lessons and Schedule.** One screen held lesson types, price bands, frequency tiers, availability windows, time off, buffers and cancellation policy — a grouping justified only by how rarely the coach opened any of it, which is a fact about frequency rather than about subject. Adding pricing made it worse: the screen grew a whole configuration surface and still had one name. The split follows the question being answered — *what do I sell?* versus *when am I free?* Cancellation policy went to **Lessons**, since notice terms are part of what's being sold rather than a fact about the calendar; scheduling preference and buffers went to **Schedule**, since they shape the day rather than the product. The one genuinely shared value, the frequent-rider threshold, lives on Lessons with the discounts it triggers, and Schedule **links to it rather than duplicating the field** — two editable copies of `frequency_tier_1_min_rides` would eventually disagree, and the number also decides who gets scheduling flexibility. Considered and rejected: keeping one screen with clearer headings, which leaves a coach scrolling past band adjustments to change a Tuesday window.

**A band's per-lesson-type amounts are editable from both the lesson type form and the band editor.** Two editing surfaces onto one field (`Lesson_Types.band_adjustments`), deliberately, because the coach genuinely asks the question both ways round: pricing a lesson type she's setting up, and pricing a band she's just defined. One surface always makes the other question tedious — from the type form, "what is after school worth across the board?" means opening every type in turn and holding four numbers in her head. The field is shared rather than mirrored, so neither view can go stale, matching the no-ride-horses precedent. A zero deletes the key rather than storing `0`, so the absent and the explicit-nothing cases can't diverge depending on which screen wrote them. **Reopens if a third surface ever wants the same field** — at that point the amount probably deserves its own tab rather than living as a map inside `Lesson_Types`.

**Terms are edited in place, with no version history.** The alternative — immutable published versions, signatures pointing at a version number, a material/minor flag deciding whose signature survives — was built and then removed. It answered *"what exactly did this rider agree to in March"* at the cost of a re-signature flow, a binding-version rule, a materiality judgement on every edit, and a booking gate that fired on everyone at once. **The changes section makes that machinery unnecessary rather than merely optional**: once a rider has agreed that the current terms are the ones that apply, "which version am I on" is not a question the product has, and a version history would sit there implying an answer that contradicts the agreement. One set of terms in force at any moment is the model the words describe, and the model should match the words.

**Scheduling a lesson after a change is the acceptance of it.** This is the term that carries the whole design, so it gets its own section and its own tick rather than a clause inside the waiver — a rider agreeing to it should have to notice it. Three things follow. The coach must notify on every change, since that's part of what the rider agreed to, which is why the update note is required and the save is blocked without it. `Bookings.created_at` had to be added, because otherwise "scheduled after the change" is unanswerable — a lesson booked last month and ridden next week accepts last month's terms, and only the creation timestamp can tell the difference. And **both sides get to see the mechanism operating**: the coach sees who has booked since the change, the rider sees what their own bookings have already accepted, along with the plain statement that not booking is the way to decline. A clause nobody can check is a clause nobody trusts.

**The only gate left is "has never signed at all."** A change to the terms produces a notification and nothing else — no Home banner, no blocked booking — because there is nothing for the rider to do, and inventing a task would contradict the mechanism they agreed to. A rider who has never signed still can't book, keeps every booked lesson, and can still cancel and message their coach: the coach's exposure is riding without a waiver, and stranding someone from a lesson they've paid for is a worse outcome with a real chance they turn up anyway.

**The pricing disclosure states the mechanism; the numbers are generated.** A hand-written price in a waiver goes stale the first time a band is edited. The coach writes how pricing *works* — bands, frequency tiers, gap-fill offers, floor and ceiling, the fact that a booked price is fixed — and current figures are appended from live config beneath it. **Reopens if a price itself ever needs to be a signed term**, e.g. a prepaid block at a locked rate.

**Include / don't-include is per section, and the master switch was removed.** Coaches don't all want the same agreements — a coach teaching at a facility with its own signed waiver may want payment terms and horse welfare and nothing else — and one global switch forces an all-or-nothing choice the product has no reason to impose. Once inclusion sits on the section, a separate `require_disclosures` flag is a second way to say "collect nothing" that can contradict the first, so it was deleted rather than kept for convenience: "collect nothing" is the state where no section is included, and the screen says exactly that. **Toggling inclusion is treated as a change to the terms** — same required note, same notification — because it changes what a rider is agreeing to as much as rewording does. **Reset-to-standard restores wording but never inclusion**, since the two are separate decisions.

**Excluding the changes section is allowed, and warned about twice.** It's the section that makes every other edit binding, so switching it off quietly undermines the whole model — including the ability to change inclusions later. The product doesn't block it, because it's the coach's business and there may be a reason, but it warns at the point of the tap and again in the summary while it's off. Considered and rejected: making that section mandatory, which would be the product overriding a coach on a legal question it isn't qualified to decide.

**A signature survives a section being switched off.** A signature is a record of a past event, and a toggle shouldn't delete it — the Agreements tab keeps showing a rider when they signed even after the coach stops collecting.

**A lesson type's role is a flag on the type, never its id.** `is_intro` replaced eleven literal comparisons against `"first-time"` and `"adult-private"` scattered through the engine — the intro-options finder, the badge on a first lesson, the unlock alert, the New Booking default, the recurring-options finder, the rate block's fallback. Every one of them worked only because the seed ids were fixed strings. A real coach creates her own types with generated ids, at which point all eleven comparisons quietly evaluate false and the failure is silent rather than loud: no intro lesson is ever found, no unlock alert ever fires, the booking form defaults to nothing, and none of it throws. Verified by resolving both roles against lesson types with entirely custom ids and names. The "default" role is derived rather than stored — the first non-intro, non-group type — since a coach shouldn't have to nominate one, and a stored default is another field that can point at a deleted row.

**Deferred, with the trigger that reopens them:**
- *How "confidence" is defined for asking a clarifying question vs. proceeding* — nothing to decide until there's free text to be uncertain about. Reopens with Phase 1b conversation design, and wants a concrete example set rather than a threshold in the abstract.
- *`saddle_assignment`* — dropped from the MVP `Horses` schema. Not needed by the rules engine's safety/pairing checks. Reopens when tack allocation actually causes a scheduling conflict, at which point its structure (controlled inventory list vs. free text) will be obvious from the failure.
- *Frequency tiers stay switched off at launch* — not a design deferral but a structural one: the tier is computed from completed calendar months, and on day one there aren't any. The schema, the recompute rule and the Profile block all ship in Phase 1a; the thresholds start blank, which renders the whole mechanism invisible. **Reopens after the pilot's first full month**, when there's a real distribution of ride counts to set 8 and 12 against instead of guessing. Bands, the receipt and gap-fill offers have no such dependency and are live from the start.
- *Archiving a lesson type, rather than only deleting it* — a type that has ever been used can no longer be deleted, which protects history but means a coach who stops offering "45-min child private" carries it in her list forever. The right answer is an `archived` flag that hides it from pickers while keeping it resolvable for past lessons. **Reopens the first time a pilot coach's lesson-type list has something dead in it**, which will happen within a season.
- *Removing a horse or a rider* — neither can be deleted today, only deactivated, which is why the many `horses.find(...)` and `students.find(...)` lookups in the render path are safe. A real barn will need removal: a horse is sold, a rider leaves for good. Null-safe `horse_name` / `lesson_type_name` / `student_name` helpers exist for this, but the render sites haven't all been migrated to them. **Reopens the moment a deletion path is added for either** — and the migration should come first, not after, since every unguarded lookup becomes a white screen on the same day.
- *Countersignature, and any legal weight beyond a tick and a timestamp* — the product records who signed and when, plus what they have booked since the terms last moved, which is what a coach can reasonably ask software to do. It does not do identity verification, witnessed signatures, IP/device capture, or PDF generation for counsel. **Reopens if a coach's insurer or facility asks for evidence this can't produce**, which is the moment the real requirement becomes knowable rather than guessed at.
- *Guardian identity for minors* — the product states that a parent or guardian must complete a minor's profile and that the signature is theirs, but it can't tell who actually tapped the button, and `signed_name` is simply what was on the profile. Tied to the deferred minor/parent-as-separate-entity question; both reopen together.
- *Reporting on what discounts actually cost* — the component columns make "how much did I give away in gap-fill discounts last month" a one-column sum, but no screen asks it. Reopens the first time a coach wants to know whether discounting filled gaps that would otherwise have stayed empty, which is the question the `Offers.kind` field was already being kept for.
- *Group lesson pricing* — group types take bands and frequency discounts like any other, but are never gap-fill offered (they're excluded from slot discovery entirely), so `gap_fill_discount` is meaningless on them and the form hides it. Per-head vs. per-session pricing isn't modelled at all: `base_price` is per booking, and a group of four is four bookings. Reopens if a coach prices a group as a session rather than per rider.

---

## 10. Rules Engine — Core Checks

Every booking request — regardless of which interface it came from — runs through one entry point, `validate_and_create_booking(request)`, which runs the checks below **in order** and returns the first failure as the reason — specific and human-readable rather than a generic rejection. That specific reason is what feeds the "ask a clarifying question" behavior (e.g. "Buttercup's already at her daily riding limit" is useful; "booking failed" is not). *The ordering is about which reason gets reported, not about short-circuiting:* screens that show a live validation checklist (New booking, the horse-swap sheets) evaluate every check so the coach can see the full picture at once, and a substitute recommendation names the first failing check for each rejected horse. Committing the booking still requires all checks to pass.

1. **Trainer availability** — requested date/time falls within *any* of that day's `Trainer_Availability` windows (a day can have more than one, e.g. a split shift), and the date doesn't fall inside an active `Trainer_Time_Off` block.
2. **Horse active** — `Horses.active` == Y.
3. **Horse rest day** — rolling 7-day window ending on the requested date (inclusive): count the distinct dates in that window where the horse has at least one `pending`/`confirmed` booking, *including* the date being requested. That count must not exceed `7 - rest_days_per_week`. No new field needed — this is computed on demand from `Bookings`, same "computed not stored" pattern as the usage-cap check.
4. **Horse usage cap** — sum `ride_time_min` across today's `pending`/`confirmed` bookings for this horse. If this lesson's rider is an adult, the adult-only subset of that sum must stay ≤ `max_daily_minutes_adult`; the full sum (any rider) must stay ≤ `max_daily_minutes_overall` regardless.
5. **Pairing/suitability** — student's `experience_level` is at or above the horse's `min_experience_level`; if `adult_only`=Y, student is 18+; student's `riding_styles` overlaps the horse's; student's `weight` is at or below `max_rider_weight_lbs`; the horse isn't in the student's `no_ride_horse_ids`.
6. **No double-booking** — two separately reported checks, since they fail for different reasons and only one of them can ever relax: **Horse free** (the horse isn't already booked in an overlapping window) and **Trainer free** (the trainer isn't already committed to a conflicting session). Validation checklists list them as two lines. *(One narrow relaxation on the trainer half for group lessons — see note below.)*
7. **Pricing** — the price is computed by `price_for` (below), not typed and then validated. The check confirms the computed total is a whole number and sits within the lesson type's `min_price`/`max_price`, and reports the floor or ceiling **by name** when it binds — never silently clamping. This is the one check that adjusts rather than rejects: a price below the floor becomes the floor and says so, where a horse over its usage cap simply fails.

If all checks pass: create the `Bookings` row. `is_new_student` is set by checking whether this is the student's first-ever row in `Bookings`; `is_billable` follows the status-derivation rule from Section 8.

**Resolved — group lessons and check #6:** the check has two halves, and only the trainer half relaxes.

- **Trainer conflict** allows an additional booking at an already-committed time when the overlapping bookings share `lesson_type_id` + date + `start_time`, that lesson type is `is_group`, and the current roster is below `max_group_size`. No `group_id` field: a session *is* those three matching values, so there's nothing to keep in sync and no way for a booking to claim membership in a group it doesn't actually share a slot with.
- **Horse conflict never relaxes.** Every rider needs their own horse, so two bookings on one horse in overlapping windows is a genuine conflict whether or not it's a group.

Two consequences that fall out of this and are easy to miss:
1. **Every schedule list collapses a group into one row**: one time, the session, its riders and their horses. Four stacked rows at 10:00 is visually indistinguishable from four double-booked privates, which undercuts the point of the check. This lives in the shared schedule-list component (Section 11 preamble), so Day view, Week Ahead and Horse detail all get it without deciding separately. The exception is Student profile, which shows one student's own lessons — there's nothing to collapse when only their row appears.
2. **Cancelling is always per-student, never per-session.** One rider dropping out frees a spot and touches no one else's `Bookings` row; ending the session itself is a separate act on every row in it.

*A third consequence recorded in the previous revision — that `find_open_slots` should treat a below-capacity group as an opening — was reversed; see "group lessons are never potential lessons" below.*

**Pricing — `price_for(student_id, lesson_type_id, date, start_time, offer=None)`:** the single place a price is produced, on every interface and every booking path. Returns the total **and its components**, always together — no caller ever gets a bare number, because every screen that shows a price is required to be able to show the reasoning behind it (Section 11).

```
base            = Lesson_Types.base_price
band_adjustment = the amount this type assigns to the band containing start_time, else 0
frequency       = the amount this type assigns to the student's current frequency_tier, else 0
offer_discount  = offer.offer_discount if this booking is being created from an accepted offer, else 0
manual          = 0 at creation; set only by the coach's override on Booking detail

price = clamp(base + band_adjustment − frequency − offer_discount + manual,
              min_price, max_price)
```

Five rules govern it, and each exists to close a specific way dynamic pricing goes wrong:

- **All amounts are whole dollars, so the total is a whole number by construction.** There is no rounding step anywhere in this product, which is why there's no rounding rule to get wrong.
- **The floor is announced, not applied quietly.** When stacked discounts would land below `min_price`, the coach sees what actually happened: *"Frequent rider (−$5) and gap-fill (−$15) would land at $45, below your $50 floor for this type. Charging $50."* A coach who believes she gave $20 off and gave $15 finds out from a student otherwise, which costs more trust than the $5 was worth.
- **The ceiling binds manual overrides, not configuration.** A band adjustment that would push a type above its own `max_price` is rejected on Lessons, where the coach can fix it, rather than clamped at booking time, where it would read as the system quietly disagreeing with a setting she deliberately entered.
- **Discounts stack; premiums don't compound.** A tier-2 student taking a gap-fill offer in a premium hour gets both discounts against the premium base — the arithmetic is one addition and two subtractions, in that order, and reads the same forwards and backwards.
- **The components are stamped onto the `Bookings` row at creation and never recomputed.** `price_for` runs once per booking. Everything after that reads the stored columns, which is what lets a student ask in November why they were charged $60 in March and get an answer.

**Where `offer_discount` may be non-zero — the fairness firewall.** Only when the booking is created from an `Offers` row the coach sent carrying a discount. A student who opens their own Home tab, finds the identical open slot, and books it pays the undiscounted price. This looks arbitrary written down and is the most important rule in the pricing design: a discount the student can obtain by waiting is not a gap-fill incentive, it's a lower price with extra steps, and it teaches every student to stop booking at full rate. The coach offering it is what the discount is *for*.

***Considered and rejected — automatic demand-responsive pricing***, where a price falls as a day stays empty or rises as it fills. It answers the same coach need (an empty Thursday is worth discounting) and it is the one mechanism in this space that cannot be made transparent: the price moves on inputs the student can neither observe nor predict, so every "why is it $55 today" has an answer only the system knows. The offer path reaches the same economic outcome — the empty day gets filled at a discount — while keeping the cause nameable: a person decided, said why, and it applied once. **Reopens if the pilot shows coaches routinely sending gap-fill offers to the same students at the same discount week after week**, at which point the manual step is ceremony around a rule that already exists and should be written down as one.

**Slot discovery — `find_open_slots(date)`:** a separate function from the validation checks above, since it's discovery rather than validation of a specific request. Powers the Day screen's "potential lessons" view (Section 11). For a given date:
1. Start from that date's `Trainer_Availability` windows (skip entirely if the date falls inside a `Trainer_Time_Off` block).
2. Take the lesson types the coach has opted in via `potential_lesson_eligible`. **If none are eligible, there are no potential lessons that day** — this is the coach's setup deciding what gets offered, not the system's guess. Group types are excluded unconditionally (see below).
3. Subtract time already covered by `pending`/`confirmed` `Bookings`.
4. Filter candidates through `offer_respects_preferences` — `Trainer_Config.min_buffer_min` is always required around every existing lesson; `max_buffer_min` and `max_back_to_back` additionally apply only when `scheduling_preference` is back_to_back. This step decides what's worth *offering*, separate from the hard validation checks above.
5. For each remaining window and each eligible lesson type whose `duration_min` fits inside it, check every `active` horse against the rest-day check (#3) and the usage-cap check (#4) — same logic as validation, run speculatively. A type qualifies for that window if at least one horse both fits the pairing rules and has `ride_time_min` of headroom left that day.
6. Output: **one entry per open window**, carrying the qualifying lesson type(s) and, per type, the horses that qualify — not one entry per window × horse, and not one per window × type. This matters beyond tidiness: an earlier prototype emitted a row per horse, so a single 9am gap with four free horses read as "4 open slots," and every open-slot count in the product (Day view, Week Ahead's per-day number, the Alerts totals) inflated with the size of the barn rather than the size of the gap. **Every open-slot count in the UI is a count of windows.** Surfaced to the trainer for *their* decision on outreach.

**Resolved — group lessons are never potential lessons.** `potential_lesson_eligible` is forced N for any `is_group` type, and slot discovery ignores group sessions entirely. **This reverses a decision recorded in the previous revision**, which held that a group session below `max_group_size` should surface as an opening. The reasoning that overturned it: filling a gap by adding a rider to a live group isn't one offer, it's a coordination problem — the added rider needs their own horse, the session's other riders are already committed, and pricing a late joiner against a group rate is a different conversation from discounting an empty window. The complexity isn't worth what it fills. A below-capacity group therefore counts as ordinary coach-busy time in `offer_respects_preferences`. What survives from that decision: the relaxed trainer half of check #6 (a coach can still add a rider to a group *manually* via New booking) and the collapsed group row on the schedule. This does not message students automatically in Phase 1a; automated outreach to fill an opened slot is F4's job (Phase 2). Here, the trainer sees the opportunity and decides whether/how to act on it (e.g. offering a discount).

**Rest-day forecast — `forecast_rest_status(horse_id, as_of_date)`:** distinct from check #3, which only validates whether *one specific new booking* would push the horse over its rest-day limit at the moment it's requested. This function instead looks at the horse's **already-booked** schedule (not actuals) to warn the trainer before a conflict becomes locked in. For a 7-day forward window starting `as_of_date`:
- `booked_days` = count of distinct dates in that window where the horse already has a `pending`/`confirmed` booking.
- `capacity` = `7 - rest_days_per_week` (the max days the horse can be ridden in any 7-day window).
- **Red** — `booked_days > capacity`: the currently booked schedule has already locked in more riding days than the rest rule allows; a lesson needs to be moved.
- **Yellow ("due for rest soon")** — `booked_days == capacity`: no slack left; every remaining open day in the window must stay unbooked, or it tips into Red. This is also the state where the trainer should be cautious about accepting a "potential lesson" fill (Section 11) for this horse on one of those remaining open days.
- **Green** — `booked_days < capacity`: normal, no action needed.
Powers the Horses screen's rest-day readout (Section 11).

**Student-matched opportunities — `find_matching_open_slots_for_student(student_id)`:** runs `find_open_slots` across the rolling 7-day window, then filters to slots where this specific student would actually be eligible (same pairing check as #5, run against at least one horse available in that slot) *and* the slot's time overlaps either `target_riding_times` or `potential_riding_times`, gated by the student's `notification_preference` (target_only / target_and_potential / all). Each result is tagged with *which* list it matched — this isn't just bookkeeping: a `target` match is a normal opening notification at `price_for`'s full price, while a `potential` match is specifically the case worth pairing with a discount, since it's a time the student wouldn't otherwise book but would take to help fill a gap. As of v5 that distinction is mechanical rather than advisory: the notify sheet offers a discount control on the potential group and none on the target group, and the amount lands on `Offers.offer_discount`. Surfaces on the Student profile screen (Section 11) as opportunities the coach can choose to notify the student about — same manual-trigger pattern as the Day view's potential lessons, not automatic outreach.

**Usage-cap forecast — `forecast_usage_cap_status(horse_id, date)`:** the daily-cap counterpart to `forecast_rest_status`. Sums `ride_time_min` across that horse's `pending`/`confirmed` `Bookings` for the given date; **Red** if the total exceeds `max_daily_minutes_overall` (or the adult-specific subset exceeds `max_daily_minutes_adult`). Like the rest-day Red state, this shouldn't be reachable if check #4 is enforced correctly on every booking — its real value is as a safety-net signal that something upstream (a config change after the fact, a booking created through a path that skipped validation) needs auditing.

**Intro lesson options — `find_intro_lesson_options(student_id, limit=10)`:** used right after a new student's profile is created (F1). Similar to `find_open_slots`, but scoped to the "first time student" lesson type, its `restricted_horse_ids` intersected with this specific student's pairing eligibility, and matched against the *union* of the student's `target_riding_times` and `potential_riding_times` (no `notification_preference` gating here — this is a direct interactive choice, not a passive notification). Unlike the standard 7-day rolling views, this search isn't capped to 7 days — it searches forward until it finds `limit` options (or reasonably exhausts a wider horizon), since a brand-new student choosing their very first lesson benefits more from real choice than from a fixed window.

**Recurring lesson options — `find_recurring_lesson_options(student_id, limit=10)`:** the recurring counterpart, used on the "Add recurring lesson" screen (Section 13). Meaningfully different from the intro version, not just a parameter swap: a candidate here is a **day-of-week + time + horse** combination, and it has to hold up as a sustainable *pattern*, not just be open on one date. A candidate qualifies if its **next 4 occurrences** all pass — trainer availability, and the horse's eligibility, rest-day, and usage-cap checks — a fixed, bounded lookahead rather than an open-ended one, so the computation stays cheap regardless of how far the underlying data goes. Matched against the union of `target_riding_times`/`potential_riding_times`, same as the intro version; also not capped to a 7-day *search* window (finding candidate day/times can look as far as needed to find `limit` of them), but each candidate's own validity check never looks past its first 4 occurrences.

**Cancellation disposition — `cancel_disposition(lesson_id)`:** decides which cancellation a student is entitled to, from lead time alone. Lead time is minutes to the lesson's `start_time`, not days to its `date`. Three outcomes: more than `late_cancel_hours` away → `early_cancel`, not billable; inside that window but not yet started → `late_cancel`, billable at full `price`; already started → **no student action at all**, because whether it was a no-show or a late cancel is a judgement the coach makes, not something to infer from silence.

*The student never chooses between early and late.* Offering both would make an economic decision look like a preference, and every student would pick the free one. One function decides the outcome, the label, and the billing flag together, so the button text and what actually gets charged cannot drift apart. The coach retains an unconditional override on both types from Booking detail (Section 11) — that's a correction, deliberately not subject to the same rule.

**Year-to-date ride counts — `rides_by_horse(student_id)` / `rides_by_student(horse_id)`:** the same derivation pivoted two ways. Counts `Bookings` rows that are `completed` and fall in the current calendar year: `no_show`, `late_cancel` and `early_cancel` all mean nobody rode, so none of them count. Anything with zero completed rides never appears, which is what keeps both lists self-filtering rather than needing an explicit "only show horses they've ridden" rule. Calendar year, not rolling — it resets on Jan 1, matching how a barn thinks about a season. Powers the student's own Profile tab, the coach's Student profile, and Horse detail (Sections 11 and 13).

**Alert generation — `generate_alerts(horizon_days=7)`:** the function behind the Alerts screen (Section 11). Scans the rolling window and always surfaces, regardless of any toggle:
- Any lesson whose recurring pattern's horse is inactive with no confirmed `Substitution_Assignments` covering it ("needs substitute").
- Any horse with `forecast_rest_status` = Red within the window ("booked past a rest day"), dated to **the day that tips the window over** — the (`7 - rest_days_per_week` + 1)th riding day — not to today. The alert names that date and the rule it breaks, since "this horse needs a rest day" isn't actionable without knowing which lesson to move.
- Any horse/date with `forecast_usage_cap_status` = Red, checked **across every day of the rolling window rather than only today**, and dated to the day it lands. A cap breach four days out is worth surfacing while there's still time to move a lesson; catching it the morning it happens defeats the purpose of forecasting against booked schedule instead of actuals. The alert says which cap and by how much (adult vs. overall), because those have different fixes.
- Open `Student_Notes` (e.g. a new student whose intro-lesson options didn't fit). What the coach actually does to resolve one is deferred — for now it just needs to surface, per your direction to work that flow out later.
- A `Students` row with `profile_status` = pending_review ("new profile awaiting review").
- An intro lesson (`Lesson_Types` = "first time student") that just became `completed` for a student whose `recurring_potential_unlocked` is still N. One-tap "Unlock" right on the alert card — no separate screen, since there's nothing else for the coach to decide here beyond the yes/no itself.
- **Informational, not blocking:** any new recurring lesson a student just self-scheduled. No approval gate — the student's confirmation already stands on its own (Section 13) — this alert exists purely so the coach isn't finding out about a new standing commitment by accident later. Styled distinctly from the three blocking categories above (neutral, not red) so a coach scanning fast doesn't mistake routine awareness for a problem.
- **Informational:** occurrences returned to their dominant horse when that horse came back from an inactive period, named individually. The coach may have told those students otherwise in person, and Phase 1a has no outbound messaging to correct it.
- **Informational:** an occurrence left behind by a pattern edit — one that kept its old day/time because it had been individually changed, and now reads as ad hoc (Section 9). Surfaced once so a stray lesson isn't discovered by accident.
Each alert is dated **to the day the problem actually lands on**, then bucketed for display into **Today**, **Tomorrow**, or **Week ahead** (days 2-6 of the window). Worth stating explicitly because it's easy to get wrong: an alert's bucket comes from the date it concerns, never from the order the checks happen to run in. A usage-cap breach computed for today belongs in Today; a lesson needing a substitute belongs in whichever bucket that lesson's date falls in, even though the horse went inactive at some other time. A separate, togglable pass adds **potential-lesson opportunities** (`find_open_slots` results) into the same buckets when the coach has that toggle on — these are informational, not blocking, so they're opt-in rather than always-on like the three categories above.

---

## 11. Web App Screens — Coach

**Resolved — targeted edit pattern:** split by what the choice actually needs, not one pattern for everything.
- **Bottom sheet** (slides up over the current screen, dismiss returns instantly, no navigation). The built set: substitute horse, change dominant horse, move lesson (day/time), price adjustment, no-ride horses from the student's side, excluded students from the horse's side, notify students about an open slot, change a recurring pattern's horse or slot, and confirm ending a series. These are choices made from an already-filtered list — the filtering happens before the sheet opens, so a validation checklist up front would be redundant. Where an option is filtered out, the sheet says which check it failed rather than hiding it silently. *Lesson type is not a sheet:* it's a field on New booking, chosen before there's anything to filter against.
- **Full-screen dedicated flow** (the pattern already built for the intro and recurring lesson pickers, Section 13): reserved for when the system is actively recommending something with reasoning attached — those two, plus substitution recommendations (Section 11 item 3b). The "why" matters as much as the "what" there, which a bottom sheet doesn't have room for.
- **Direct toggle, no sheet**: genuine binary switches, e.g. a horse's active/inactive state.

Applies retroactively to every instance tracked below: Booking detail's reassign/reschedule/adjust-price, Student profile's and Horse detail's no-ride edit, New booking's pickers, and the student-side "Change horse"/"Change day-time" on Manage recurring lesson all become bottom sheets. The estimated-duration selector on Substitution planning was already effectively this pattern (a small set of buttons, no navigation) — just confirming it stays as-is rather than becoming something heavier.

**Resolved — one component per concept, not one per screen.** A lesson, an alert, a horse's usage, a form field and a set of chips each have exactly one implementation, reused everywhere they appear. This is a product rule, not a code-tidiness rule: when four screens each drew their own version of a lesson row, they drifted — different border colors for the same substitute state, a status badge on one screen and not another — and the coach had to relearn the same information on every screen. The shared set is: **lesson row** (Day, Week Ahead, Horse detail, Student profile — with date and student name as options, since a horse's schedule doesn't need the horse repeated and a student's doesn't need the student), **alert card**, **validation checklist**, **usage meter**, **rest-forecast badge**, **section heading with optional action**, **labelled field**, **segmented control**, **chip multi-select**, **check row**, **time picker**, **day+start+end window editor**, and **student profile fields** (shared by the student's own create/edit form, the coach's add-student form, and the coach's review screen, so there is one definition of what a profile is).

**Resolved — navigation is a back stack, not a fixed parent.** Any drill-in returns to wherever it was opened from. The same Booking detail is reachable from Day view, Week Ahead, Horse detail, Student profile, Substitution planning and Alerts; hardcoding its back button to Day view stranded the coach five of those six times. Tapping a top-level tab clears the stack.

Phase 1a screen inventory, mapped to the features/checks they serve:

1. **Day view** (home screen, defaults to today) — a given day's lessons at a glance: time, student, horse, lesson type, status. Header leads with date + weekday (e.g. "8/18 Tue"), since Week Ahead (screen 2) opens this same view for any of the next 7 days when a day is tapped — with "· Today" or "· Tomorrow" appended when it applies, so the coach can tell at a glance whether they're looking at now or at a day they stepped to. Any horse flagged inactive surfaces as a banner up top since it affects that day's lessons directly (F5's core job, brought forward from a night-before text into an always-current view). A group lesson appears as a single row — one time, the session, its riders and their horses — rather than one row per booking (Section 10). Cancelling from inside it always acts on one student, never the session.

A day falling inside a `Trainer_Time_Off` block carries its own banner, distinct from the inactive-horse one, since anything still booked underneath it needs resolving. Navigation is date-stepper plus a **Today** action that only appears once the coach has stepped off today — a rolling view needs a way home.

Also surfaces **potential lessons** — open slots the trainer could still fill that day, computed via `find_open_slots` (Section 10) — so the trainer can decide whether it's worth reaching out to eligible students, possibly with a discount, to fill the gap. Each slot lists the lesson type(s) that fit and the horses free in that window, and offers **Notify eligible students** — but only when at least one student's `target_riding_times` or `potential_riding_times` actually covers that slot. With no match, the action is replaced by plain text ("No matching student availability") rather than shown as a live button that opens an empty screen: a control that looks pressable should do something.

A filter — **only slots a student could take** — collapses the list to windows with at least one matching student. A full open day legitimately produces a dozen-plus windows, most with nobody who asked for that time; the filter is the difference between scrolling all of them and seeing the two worth acting on.

**A slot changes state once offers go out.** It doesn't disappear — an offer holds nothing, so the window is still genuinely open — but it stops reading as an untouched gap, because the coach's question has changed from "who could take this?" to "has anyone come back to me?" The card names who was offered (first three, then a count), says plainly that the slot stays until someone books it, and replaces the action with **Notify N more** covering only the matching students who haven't been asked yet. When everyone matching has been offered, that becomes text rather than a button, since there's no one left to send to. The section heading carries the same signal in aggregate: "12 open · 2 awaiting a reply". Reversing the notification through Undo returns the card to its untouched state, since the `Offers` rows are what the card reads from.

**The notify screen** lists candidates in two labelled groups, target matches first, then potential matches. The order isn't cosmetic — a target offer goes out at full price, while a potential one is the discount case (Section 10), so the cheaper-to-fill option should be exhausted first. Within each group, students are ordered by **how often they've taken an offer before**, most likely first. That rate is derived, not stored: an `Offers` row counts as accepted when a `Bookings` row exists for that student at that date and time. It's smoothed as `(accepted + 1) / (offered + 2)` so a student with no history sits at a neutral 0.5 rather than at the bottom — a newcomer hasn't declined anything, and a single early yes shouldn't read as a perfect record.

**Potential-match offers carry a discount option.** The group heading isn't decorative — a target offer goes out at `price_for`'s normal price, while a potential one is the gap-fill case, so the potential group has a discount control above it: the lesson type's `gap_fill_discount` as a one-tap preset, a custom whole-dollar amount, or none. One amount applies to the whole batch (it's one slot, and offering the same window to five students at five different prices is indefensible the moment two of them compare notes), and the sheet shows the resulting price with its reasoning — *"$55 instead of $65"* — before sending, plus the floor warning if it binds. A reason field sits in the same step and is required when a discount is set, per the capture-the-why rule. Amount and reason land on the `Offers` row and, if the student books, on the resulting `Bookings` row's `offer_discount` and `notes`. **The target group has no discount control at all**, since a full-price offer is what makes it the group tried first.

**The top five are pre-selected**, since that's the batch the coach would almost always send; the coach can add more or remove any of them, and sends one batch. Each notification writes an `Offers` row carrying its position in the ranked list as `rank`. Students already offered that exact slot are shown with a marker and left unselected; students already booked at that time don't appear at all. Notifying is one-way — it neither creates a booking nor holds the slot, so first to book takes it. Open slots collapse to the first few with a **Show all N** toggle, since a lightly-booked day can legitimately have a dozen.
2. **Week Ahead** (renamed from "Next 7 days" / "week grid") — a rolling day-by-day agenda, not a literal 7-column grid; a true grid is unreadable at mobile width once lesson details are legible. Each day shows both its lesson count and its open-slot count (from `find_open_slots`, no detail — just the number), and is tappable, opening that date's Day view (screen 1, generalized — see below). Carries forward any unresolved flags (e.g. a recurring lesson still needing a substitute) so nothing gets lost between screens. Rolling like the rest of the product's views — always today through the next 6 days, not a fixed Monday-Sunday calendar week.
3. **Horses** — roster with today's/this-week's usage against each horse's caps, active/inactive toggle (mark a horse out, e.g. lame), and a rest-day forecast (Red/Yellow/Green per `forecast_rest_status`) based on the *already-booked* schedule for the coming week, not past actuals — so a conflict is visible while there's still time to move something, not after the fact. Each horse card shows a usage bar against whichever cap (`max_daily_minutes_adult` or `max_daily_minutes_overall`) is more relevant/constraining that day, plus its suitability tags (`min_experience_level`, `riding_styles`, `max_rider_weight_lbs`) at a glance — so the trainer can sanity-check a pairing without opening the student's profile. *Health/maintenance tracking (vet visits, farrier schedule) considered and explicitly deferred to Phase 2 — not part of this product's core scheduling problem for now.*
3-i. **Add / edit horse** (from the Horses roster, or Edit on Horse detail) — the screen that was missing: every field the rules engine relies on (`min_experience_level`, `adult_only`, `riding_styles`, `max_rider_weight_lbs`, `rest_days_per_week`, `max_daily_minutes_adult`, `max_daily_minutes_overall`, `notes`) was previously fixed at setup with no way for the coach to change it. Since these are the exact inputs to the pairing and welfare checks, a coach who can't edit them can't correct a wrong safety rule. Validated on save: name and at least one riding style required, and the adult cap can't exceed the overall cap. Active/inactive is deliberately *not* edited here — it's a direct toggle on Horse detail (per the targeted-edit pattern above) because it triggers the substitution flow rather than saving a form.
3a. **Horse detail** (drill-in from Horses) — a rolling next-7-days schedule (always today forward, not a fixed calendar week) showing each lesson's type at a glance — recurring, substitute, or ad hoc — plus the list of regular riders and how often they ride this horse, **year-to-date rides broken down by student** (`rides_by_student`, each row tapping through to that student), a rest-day forecast strip over the same rolling window, students excluded via `no_ride_horse_ids` (visible and editable from the horse's side too), a usage trend across recent weeks vs. cap, and the horse's notes field. The regulars list and the ride counts answer different questions and are deliberately both present: who holds a standing lesson, versus who has actually been on this horse and how often. *Workload spread across horses is shown, never alerted on* — the daily cap and rest-day rules already protect the horse, and how a coach distributes work above that line is their judgement, not something the system should second-guess.
3b. **Substitution planning** (triggered automatically when a coach marks a horse inactive) — marking a horse inactive opens a real `Horse_Inactive_Periods` row (defaulting to a one-week estimate) rather than just flipping the `active` flag, so the screen has a window to plan against. The coach adjusts the estimate from a small set of presets (3 days / 1 week / 2 weeks / 1 month) and the affected list recomputes against the new window.

   The screen shows every affected lesson in that window with a recommended substitute horse (run through the same pairing/usage-cap/rest-day checks as a normal booking) and a one-tap confirm. Recurring lessons need only one confirmation to cover every occurrence in the window (per `Substitution_Assignments`); ad hoc lessons are confirmed individually since they don't repeat. Where more than one horse clears every check, the alternates are offered alongside the recommendation — the recommendation is a default, not a verdict, and the coach often knows something the rules don't.

   Lessons with no eligible substitute are flagged clearly rather than silently skipped, and say **why**: either no horse matches the student's pairing rules at all, or the closest candidate names the specific check it fails (e.g. "Rocket — Within usage cap"). A bare "no eligible horse" tells the coach nothing they can act on.

   A confirmed substitution stays on the list as *covered*, with an **Undo** that both drops the `Substitution_Assignments` row and returns the affected occurrences to the dominant horse. Marking the horse active again ends the period (setting `actual_end_date`), returns future occurrences to the dominant horse where the rules engine still clears them against the returning horse, leaves the rest on their substitutes, and announces what moved on Alerts (Section 9). Matching is on the *pattern's* horse, not the occurrence's, precisely so that already-covered lessons remain visible — an earlier version matched on the occurrence and covered lessons vanished from the screen, leaving the coach unable to tell "handled" from "never existed." If the horse ends up out longer than estimated, the coach returns to this screen manually to extend coverage — no automatic re-prompting in Phase 1a; that's the proactive-alerting feature's territory (see note below), designed separately.
3c. **Lessons** — everything about *what the coach teaches and what it costs*. Together with **Schedule** (3d) this replaces the single Setup screen: one screen holding lesson types, price bands, pricing rules, availability windows, time off, buffers and cancellation policy was a grab-bag held together only by "configuration the coach sets rarely," which is a statement about frequency rather than about subject. The split follows the question the coach is actually answering — *what do I sell?* versus *when am I free?* — and each screen names where the other half lives rather than assuming it's discoverable. This is also where `late_cancel_hours` is set, since a cancellation policy is a property of the lesson being sold, and it's the only place the student-facing cancellation behaviour can be changed:
   - **Lesson types**: view/add/edit/delete `Lesson_Types` — name, **whether it's the first-lesson type**, duration vs. ride time, group settings, **pricing (below)**, and the two optional restrictions (`restricted_horse_ids`, `riding_styles`). Ride time can't be saved above calendar duration. **Deleting is blocked while *any* `Bookings` row references the type — past as well as upcoming — or any active recurring pattern does.** The guard originally checked only upcoming lessons, which let a coach clear next week, delete the type, and orphan every past booking that used it: those lessons then can't say what they were or why they cost what they did, and the rider's history renders a crash rather than a row. Where only past lessons block it, the screen says so and suggests removing the type from availability instead of deleting it.
   - **Pricing lives inside the lesson type form, not on a screen of its own.** Adding a lesson type is where a coach is already deciding what that lesson *is*, and what it costs is part of that answer; a separate Pricing screen would mean setting up a type and then remembering to go price it, with a half-configured type in between. The form's pricing block, in order:
     - **Base price, floor and ceiling** (`base_price`, `min_price`, `max_price`). The floor is explained on the screen as the point below which no stack of discounts can go, since it's the field that quietly does the most work.
     - **One row per price band the coach has defined** (below), each with a signed whole-dollar amount for *this* type and defaulting to 0 — so a coach who wants a premium on 60-minute privates but not on the 30-minute kids' hour expresses that by leaving one blank rather than by defining two sets of bands. The band's name and hours are shown read-only beside the amount; editing the *window* happens once, in the bands section, though the same amounts can also be set there across every type at once. **With no bands defined this block doesn't render at all** rather than showing an empty state, since a coach who hasn't opted into time-based pricing shouldn't have to scroll past it on every lesson type.
     - **Frequency discounts** — one amount per tier the coach has configured in the Frequent riders section below, labelled with that tier's actual threshold ("8+ rides/month: $___ off") rather than "Tier 1", so the form reads as the sentence the coach would say to a student. Blank means this type isn't frequency-discounted, which is the right default for an intro lesson.
     - **Gap-fill discount** (`gap_fill_discount`) — the preset the notify sheet offers with one tap. Explained as a suggestion rather than a limit: the sheet still allows a custom amount.
     - **A live worked example** underneath, recomputed as the fields change: the type's cheapest and dearest realistic prices with their reasoning spelled out — *"$50 (base $60, weekday morning −$5, 12+ rides −$5) to $75 (base $60, after school +$15)"* — plus a warning when a band would breach `max_price` or the discounts would routinely hit `min_price`. A coach can enter four numbers that individually look sensible and collectively produce a $30 spread they never intended; the example is how they find out on Lessons rather than at the first booking.
   - **Price bands**: add/edit/remove `Price_Bands` — a name, days, and a start/end time, capped at three, with overlaps rejected on save and the conflicting band named. Sits directly below lesson types because it's read by every one of them.
   - **The band editor also edits every lesson type's amount for that band**, in one list — the *second* surface onto `Lesson_Types.band_adjustments`, not a copy of it. Both exist because the coach reaches the same number from two directions: *"what does this lesson cost?"* while setting up a type, and *"what is after school worth?"* while defining the band. Routing the second question through four separate lesson type forms is how a coach ends up with a premium on three of them and a blank on the fourth without noticing. Same precedent as no-ride horses being editable from both the horse and the student side (Section 9): two ways in, one field, so the two can't tell different stories. Each row shows what that type would charge in the band (*"base $65 → $75 in this band"*), so the consequence is visible at the moment the number is typed. **A zero deletes the entry rather than storing `0`**, keeping "not priced for this band" and "priced at nothing" the same state however the coach arrived at it.
   - Removing a band that any lesson type prices is blocked with the same disabled-control-plus-reason pattern as deleting a lesson type in use — silently zeroing an adjustment on three lesson types is not something a coach should be able to do by tapping one X. The disabled control now names the way out (*"set its amounts to 0 in Edit first"*), which the band editor makes a one-screen job rather than a tour of every lesson type.
   - **The `max_price` ceiling is enforced identically from both directions** — a band amount that would push a type above its own ceiling blocks the save, in the band editor and in the lesson type form alike, each naming the type and the ceiling. The same rule has to bite whichever way the coach came at it, or one screen quietly permits what the other rejects, and the difference only surfaces as a clamped price weeks later.
   - **Frequency tier thresholds** (`frequency_tier_1_min_rides`, `frequency_tier_2_min_rides`) live here, with the discounts they trigger, because what a tier is *worth* is a per-lesson-type amount and this is the screen those amounts are on. The tier-1 threshold is also `prioritization_rule`'s number, so **Schedule links back to this section rather than carrying a second copy of it** — one definition of "frequent rider," driving both who gets scheduling flex and who gets a discount. Setting it in two places would let them disagree, and a coach explaining why a student is one but not the other is a conversation with no good answer.
   - **Cancellation policy** (`late_cancel_hours`) — the notice a student must give for a cancellation to be non-billable. Placed here rather than on Schedule because it's a term of sale attached to the lesson, not a fact about the coach's calendar.
   - All time entry across this screen and Schedule (and the whole product) uses a picker rather than free text. Typed times invite `8:00`, `08:00`, `8am` and `0800` for the same instant, and the availability windows feed a hard scheduling check.

3d. **Schedule** — *when the coach is available, and how the day gets packed*. Nothing about lesson content or price appears here; the screen opens by saying so and pointing at Lessons.
   - **Recurring weekly availability**: `Trainer_Availability` windows, editable per day, with more than one window allowed per day (e.g. 8am-12pm and 3pm-8pm the same day for a split shift) rather than assuming one continuous block.
   - **Time off**: a separate overlay on `Trainer_Time_Off`, not an edit to the recurring pattern — add a date range with an optional reason, view existing blocks, remove one. Creating a block that conflicts with an existing lesson surfaces that conflict on Alerts and highlights it on Day view and Week Ahead (see below) rather than silently leaving it stranded.
   - **Scheduling preference and buffers**: back-to-back vs. spaced, minimum buffer (always enforced), maximum buffer and max-back-to-back (both only affect what times get *offered* to students, and only matter when the preference is back-to-back). Explanatory text on the screen spells out this interaction directly, since the two buffer fields do genuinely different jobs and that's easy to lose track of. The same explanatory block carries the pointer to the frequent-rider threshold on Lessons, since *which* riders get scheduling flexibility is decided by a number that isn't on this screen — an omission worth naming rather than leaving the coach to discover.
3e. **Info & disclosures** — the agreements a rider signs before their first lesson.
   - **Include / don't include sits on each section**, with a running count at the top (*"Riders sign 6 of 7 sections"*) and, where nothing is included, a plain statement that riders aren't asked to sign anything. Excluded sections stay on the screen, greyed and badged, since a coach who turned one off will want to find it again.
   - **Turning a section on or off is a change to the terms**, treated exactly like rewording one: it needs the same change note and triggers the same notification, because it alters what a rider is agreeing to. The save card says so when an inclusion has flipped.
   - **Seven sections, each editable in place** with a *reset to the standard wording* per section, so a coach who rewrites one badly can back out of that one without losing the others. **Reset restores wording only, never inclusion** — how a section is worded and whether it's collected are separate decisions, and silently switching one back on while restoring the other would be a surprise. Sections with unsaved edits are badged, so "I typed something" and "riders can see it" are never confused.
   - **The pricing section describes the mechanism; the live figures are appended automatically** and regenerate from `Lesson_Types`, `Price_Bands` and the tier thresholds. Otherwise it goes stale the moment a band changes. Specific prices reach riders through receipts and `rate_changed` alerts (Section 13); the disclosure covers the rules those follow.
   - **The changes section carries two warnings**: one in its editor, and one **at the moment it's excluded**, since excluding it is now a single tap and costs the coach something she can't see. Without it riders never agree that the terms can change after signature, so every later edit may fail to bind anyone who signed before it — including the per-section inclusions. The top-of-screen summary repeats this in red while it's off. It's the one section where editing freely runs against the coach's own interest, so the product says so wherever that choice is made.
   - **Saving asks for one thing**: a required one-line *what changed*. The card states plainly that the new terms replace the old ones immediately and apply to every rider including those who signed the earlier wording, that nobody is asked to sign again, and that everyone is notified.
   - **Where riders stand**: how many have signed at all, who hasn't, and — separately — **who has booked a lesson since the terms last changed**. The second view is what makes the changes clause observable rather than merely asserted: it's the coach seeing acceptance happen. Riders who haven't booked since are named neutrally, with a line saying there's nothing to chase, since not booking is not a breach.
   - **A preview of exactly what riders see** — the included sections only, rendered by the same component the rider's screens use, so the preview can't disagree with the real thing.
   - A standing line that none of this is legal advice, calling out the changes section specifically.


4. **Students** — roster. Each card shows the student's next upcoming lesson (mirroring how the Horses roster leads with usage), plus a flag if anything about that upcoming lesson is unresolved (e.g. Taylor B.'s recurring lesson currently needing a substitute carries through here too, same as it does on Week Ahead). An **All / Pending review** filter sits at the top, giving the pending-review queue a home outside the Alerts screen. There is no **Add student** action: profiles are authored by the student or guardian only (Section 9).
4-i. **Edit student** (from Edit on a student's profile) — the same shared profile-fields component the student's own form uses, with name and phone added and the target/potential window editor included. **There is no coach-side create** (Section 9): the roster has no "add student" action and New booking's student picker offers only existing students, with a line explaining that a new rider creates their own profile. The coach can correct any field afterwards, including the required contacts, but can't author the profile — and can't save an edit that would leave it incomplete.
4a. **Student profile** (drill-in from Students) — profile fields (contact, guardian/emergency contact, age, experience level, riding styles, weight); recurring lessons (from `Recurring_Bookings`); a 30-day exceptions view — not every occurrence, just deviations from the standing pattern: ad hoc additions, cancelled recurring occurrences, and recurring occurrences currently awaiting an unconfirmed substitute; target and potential riding availability; **year-to-date rides by horse** (`rides_by_horse`, each row tapping through to that horse — the same data the student sees on their own Profile tab, so the two sides can't tell different stories); **messages from this student** (open `Student_Notes`, with a "Mark handled" that sets `resolved` — without it an alert has nowhere to land and no way to be cleared, so the coach's queue would only ever grow); no-ride horses (editable here *and* from the horse's side — both screens write to the same `no_ride_horse_ids` field, so there's one source of truth regardless of which side made the edit); and matched opportunities from `find_matching_open_slots_for_student`, each with a one-tap "notify" the coach can choose to send or skip — writing the same `Offers` row as Day view's version, so an offer made from either screen is visible from both.
5. **Booking detail** — open any lesson to act on it:
   - **Mark early cancel / Mark late cancel** — two explicit actions, not one "Cancel" button with the type auto-computed from the 24-hour window. Earlier drafts of this doc had the system inferring early vs. late from the current time; in practice the coach needs to make this call directly (a student calls to cancel and the coach knows which billing outcome applies), so it's their choice, not a computed one. Each sets the corresponding `is_billable` outcome per Section 8's billing rule.
   - **Reset occurrence (un-cancel)** — reverts a mistaken cancel or no-show back to confirmed. Only actionable when the lesson is currently in one of those states.
   - **Mark no-show** — only actionable once the lesson's start time has passed, and inactive whenever the lesson is already early cancel, late cancel, or no-show itself — these four outcomes are mutually exclusive for a given occurrence.
   - **Completion is automatic, not a coach action.** A `pending`/`confirmed` lesson becomes `completed` once its date has passed, unless it was explicitly cancelled or no-showed first — derived at display time, never stored as a literal status transition the coach has to trigger. There is no "Mark completed" button.
   - **Change dominant horse** (recurring occurrences only) vs. **Substitute horse** — two distinct actions with different scope, not one "Reassign" button. Change dominant horse updates `Recurring_Bookings.horse_id` and cascades to this pattern's other upcoming occurrences still on the old dominant horse (skipping any already substituted, so it never clobbers an existing substitution); it's a change to the standing pattern going forward. Substitute horse only touches this one `Bookings` row. For a non-recurring occurrence (ad hoc or first lesson), there's no dominant/substitute distinction, so only a single "Change horse" action applies. Either action re-runs the rules engine checks (#1-7) against the new horse before applying — the same underlying mechanism Substitution Planning's per-lesson "confirm" button triggers in bulk.
   - **End recurring series** — a separate action from cancelling one occurrence, updating `Recurring_Bookings.status` instead of the individual `Bookings` row. Keeping these separate matters — a coach cancelling one Thursday shouldn't accidentally end the whole series, and vice versa.
   - **Move lesson** — reschedule this one occurrence. The sheet doesn't offer a free date/time entry that then gets rejected; it lists only times in the next two weeks that pass every check (#1-7) for this exact student/horse/lesson-type combination, plus `offer_respects_preferences`. If nothing qualifies, it says so and points at changing the horse first. Scope is this `Bookings` row only — moving a whole standing pattern is the recurring-pattern edit, not this.
   - **Price** is editable here too (ties to F2's case-by-case discount decision from Section 4). The sheet now **opens on the receipt** — base, band, frequency discount, offer discount, each on its own line with the band and tier named, totalling to the current price — before offering any control, because the coach's first question when a student queries a price is what produced it, and reconstructing that from memory is how a wrong answer gets given at the barn. Below it: the computed price, a common discount step, the floor, and free entry, all writing `manual_adjustment` rather than overwriting `price`, so the receipt keeps adding up and an override is visibly an override. Validated against `min_price`/`max_price` and the whole-number rule. The reason is asked for in the same step and appended to `notes`: the discount rule from Section 4 only works if the "why" is captured at the moment the decision is made, not reconstructed later. **Editing a price never touches the pattern** — a manual adjustment is one occurrence, always, and the sheet says so on a recurring lesson.
   - **End recurring series** takes a confirmation step that states how many upcoming occurrences will disappear, and actually removes them. Ending a series while its already-generated `Bookings` rows sit on the calendar is the worst of both outcomes — the pattern is gone but the lessons still show. Past occurrences are always kept; they're history.
6. **New booking / recurring setup** — manual entry point for F1/F2, since Phase 1a has no SMS intake yet. One-time vs. recurring toggle up top; student picker (existing students only, with a line explaining that a new rider creates their own profile from the student app — the coach can't author one, Section 9); horse and lesson-type pickers pre-filtered to what's actually eligible for the selected student, rather than showing every option and rejecting the invalid ones after the fact; date/time (one-time) or day-of-week + time (recurring); **price, computed by `price_for` and shown as its receipt rather than as an editable number** — it updates live as the student, lesson type and time change, since all three are inputs to it, and a band premium appearing the moment the coach picks 4pm is exactly the transparency the model is for. An override is available behind the same sheet Booking detail uses, so adjusting a price is one deliberate act with a reason attached rather than a field that can be typed over absently. In recurring mode the receipt notes that `frequency_discount` is stamped per occurrence and will follow the student's tier as it moves, so a rate quoted today isn't misread as fixed forever. A live validation checklist runs the same checks (#1-7) as every other booking path, showing each one passing or the specific reason it's blocked — so the coach sees exactly why before submitting, not after. In recurring mode the checklist covers the first occurrence and a separate line reports the next three, naming the date and the failing check if any of them won't hold ("8/25: Within usage cap") — a weekly pattern that only works once isn't a pattern. Two rules the form enforces that are easy to miss: changing the student or lesson type clears the selected horse rather than carrying a now-ineligible one forward, and price is validated against the selected type's range on every keystroke.
7. **Alerts** — three buckets, always in this order: Today, Tomorrow, Week ahead. Several categories always show regardless of any toggle, since they're blocking, welfare, or otherwise need attention: a lesson needing a substitute; a horse forecast to miss its rest day (Red per `forecast_rest_status`); a horse forecast to exceed its daily usage cap (Red per `forecast_usage_cap_status`); a lesson that now conflicts with a `Trainer_Time_Off` block, needing manual rescheduling since there's no substitute-coach concept; a new profile awaiting review. One category is purely informational: a student just self-scheduled a new recurring lesson — no approval needed, just awareness, styled neutrally rather than with the blocking-issue red so it doesn't read as a problem. One is a one-tap action: an intro lesson just completed, ready to unlock recurring/potential for that student. A separate toggle adds potential-lesson opportunities into the same buckets — off by default reasoning doesn't apply here since these are optional/informational rather than urgent, so the coach controls whether they want that extra volume. Each alert links back to wherever it gets resolved (or, for the informational ones, to the relevant Student profile or Booking detail).
8. **Review new profile** (opened from the Alerts screen or the pending filter on Students) — every field the student entered, genuinely editable by the coach (same shared profile-fields component the student used, so a correction can't produce a shape the student form couldn't) and written back on approve, alongside the coach notes; when their intro lesson is scheduled for, linking through to its Booking detail so the coach can reassign the horse before it happens if their review turns something up; a horse-by-horse no-ride toggle list, so the coach can set `no_ride_horse_ids` based on their own assessment (F1); a coach notes field. "Approve profile" sets `profile_status` = approved.

**Resolved:** the intro lesson picker does *not* wait for `profile_status` = approved. The rules engine already guarantees the booking is sound — right lesson type, eligible horse, valid time — independent of whether the coach has reviewed the profile yet. Approval is about the coach's own judgment on top of that (no-ride horses, anything else worth flagging), not a safety gate the system needs. In the rare case the coach wants to change something based on their own read of the situation, they handle it directly with the student outside the app and make the corresponding change to the booking inside it (Booking detail) — no formal in-app request/approval flow needed for that.

Sketching screen 1 (Today) first, since it's what the coach opens most and where the horse-safety flag is most time-critical.

---

## 12. Proactive Alerting
Now designed — see the Alerts screen, Section 11 item 7, and `generate_alerts` in Section 10. Originally deferred as its own conversation since it's a different kind of screen than the rest: the others are opened deliberately, this one actively watches for developing conflicts and surfaces them without the coach going looking.

**Two alert systems, deliberately not one.** The coach's is *derived and forward-looking* — `generate_alerts` computes developing conflicts from current state every time the screen opens, each one bucketed to the day the problem lands on and each one actionable. The student's is *recorded and backward-looking* — an append-only log of changes already made, ordered by when they happened, none of them actionable. They share a name and nothing else, and merging them would force one model onto both: either the coach's alerts become stale stored rows, or the student's become underivable. Their retention differs for the same reason — a coach's alert disappears when the underlying problem is fixed, a student's after 7 days regardless.

**Neither system sends anything in Phase 1a.** Both surface in-app only. Outbound messaging is Phase 1b, at which point `Student_Alerts` is the natural queue to send from — each row already carries a recipient, a reason and a timestamp.

---

## 13. Web App Screens — Student & Parent

Built adult self-service first, per your direction — no guardian entity needed at the time. The minor/parent case turned out not to need separate screens at all: see screen 2's guardian fields below. Every screen from 3 onward is genuinely shared between an 18+ student and a guardian operating on a minor's behalf.

1. **Get started** — one entry point, not a "new vs. returning" choice for the student to make. Name + phone; the system looks up a matching `Students` row (per the login design principle in Section 8):
   - Match found, `profile_status` = approved → their Home tab (screen 5a).
   - Match found, `profile_status` = pending_review → straight on to intro lesson selection (screen 4), *not* a waiting message. An earlier draft of this section held them behind "your profile is being reviewed," which contradicts the resolved decision in Section 11: the rules engine already guarantees the booking is sound, so coach review isn't a gate the student has to clear first. Making them wait would mean a student who signs up on Sunday night sits idle until the coach next opens the app.
   - No match → straight into profile creation (screen 2), name and phone carried over so they aren't re-entered.
2. **Create your profile** — age, experience level, riding styles, weight, **emergency contact name and phone (required)**, target riding availability, potential riding availability, notification preference. The notification choice is a stacked list, not a three-across segmented control: the options are *target times only* / *target and potential times* / *any open time*, and each needs a line of explanation. A third of a phone screen forces one-word labels like "Both," which is only readable if you already know the answer. The options echo the field names directly above them verbatim, so the connection is visible rather than inferred; the coach's version of the same setting uses the same three, worded for a coach. The form lists what's still missing rather than only disabling the button, so an incomplete profile says why. Availability is entered through a day + start + end picker with add/remove, not free text and not a fixed number of slots: `target_riding_times` has no cap by design (Section 8), and these windows feed opportunity matching directly, so they have to be structured data from the moment they're typed. Deliberately does **not** ask about horses at all — a brand-new student knows none, and no-ride horses are the trainer's call after their own assessment (F1), not the student's. If the entered age is under 18, the form doesn't block — it reveals three more required fields — **Responsible Guardian Name**, **Relationship** and **Guardian Phone** (defaulting to the number the account was created with) — plus explanatory text: the guardian is responsible for all scheduling, profile info, and payment on the student's behalf. From here on, the guardian operates every downstream screen exactly as an 18+ student would — there is no separate parent-facing UI; this single conditional addition is the entire minor/parent flow. On submit: creates the `Students` row with `profile_status` = pending_review and continues to screen 3, which confirms the save and leads into picking an intro lesson — the review happens on the coach's side in parallel, not as a gate in front of the student.
3. **Profile saved** — confirms the save, and reminds them how to get back in: full name + phone, no password to remember. Leads into screen 4.
4. **Pick your intro lesson** — up to 10 options from `find_intro_lesson_options`, each showing date/time and horse. Confirming one creates the `Bookings` row directly (same validation pipeline as every other booking path, and it's a genuine ad hoc booking — no `recurring_id`). If none work, "None of these work for me" reveals a note field; submitting creates an open `Student_Notes` row (category `intro_lesson_no_fit`), which surfaces on the coach's Alerts screen — the actual resolution flow for the coach is intentionally left undesigned for now.
5. **Navigation — five tabs** (Home / Alerts / Future / Past / Profile), shown once a session exists and hidden throughout onboarding (screens 1–4): there is nothing to navigate between until an account exists, and a tab bar over a required form invites skipping it. Sub-screens (Add recurring, Manage recurring, Message your coach, Edit profile) return to the tab they belong to, not always to Home.

5a. **Home** — what needs attention now, nothing else:
   - **Message your coach** at the top, above the schedule. It's the escape hatch for everything the app doesn't model, so it shouldn't be at the bottom of a scroll.
   - **This week's lessons only** (the current calendar week), each with its cancel affordance per `cancel_disposition`. A count of everything beyond links to Future, so truncation reads as a deliberate split rather than missing data.
   - **Shown only once `recurring_potential_unlocked`:** matched potential lessons for the next 7 days (`find_matching_open_slots_for_student`, respecting `notification_preference`), each with a **"Schedule"** button — unlike the coach's notify-only version of the same match (Section 11), the student books it themselves with no coach step in between.
   - **Before unlock:** a short note in place of that section explaining it appears once the intro lesson is complete and the coach opens it up — not hidden with no explanation.

5f. **Alerts** — everything the coach changed, newest first, and **read-only by design**: nothing here asks the student to approve, confirm or reply. Approval would be the wrong model — the coach owns the schedule, and a change that needed the student's consent to take effect would leave the barn's actual state ambiguous until they opened the app. The tab carries an unread count, and Home repeats it as a card, since a badge on one of five tabs is easy to miss. Colour follows the *kind* of change, so the list is scannable without reading:

| Kind | Colour | Fires when |
|---|---|---|
| `lesson_cancelled` | red | coach cancels a lesson (either type; the detail names the charge if any) |
| `no_show` | red | coach marks a no-show |
| `recurring_ended` | red | coach ends a standing pattern |
| `lesson_moved` | amber | coach reschedules a lesson |
| `substitute_horse` | amber | a substitute is assigned, from the substitution planner or a one-off horse swap |
| `recurring_changed` | amber | coach changes a pattern's day, time or dominant horse |
| `no_ride_changed` | amber | coach adds or removes a horse from the student's no-ride list, from either side |
| `booking_created` | green | coach books an ad hoc lesson for them |
| `recurring_created` | green | coach sets up a standing pattern for them |
| `offer` | blue | coach notifies them about an open slot — the same action that writes the `Offers` row |
| `price_changed` | grey | coach adjusts a lesson's price — the detail names the old and new figure, not just the new one |
| `rate_changed` | grey | the student's `frequency_tier` moves at the monthly recompute, **in either direction**. A rise is the reward doing its job and should be seen; a drop is the case that would otherwise be discovered at the till, which is the surprise this whole model exists to prevent. The detail names the month, the ride count, and what it means per lesson |

*New since last read* is shown two ways at once — a dot and a tinted card — because colour alone already encodes severity here and can't also carry newness. Items are marked seen on opening the tab, but the highlight is snapshotted on arrival so the screen doesn't blank the very thing it was opened to show.

**Where alerts are written matters as much as what they say.** The emit call sits at each coach-side action, never inside the shared update helpers — the same `updateBooking` runs when a student cancels their own lesson, and folding the notification into it would tell students about their own actions. The cost is that a new coach action is easy to forget to wire up; the alternative, passing an actor through every write, was heavier than Phase 1a needs.

5b. **Future** — a **rolling** four weeks, grouped by week. Rolling rather than four calendar weeks: on a Saturday, calendar weeks would show one remaining day plus three weeks. Anything past the horizon is counted, never silently dropped. Also holds **recurring schedule management** — view standing patterns, add one, change one — with the pattern-vs-occurrence distinction stated in words, since the per-lesson cancel buttons make the two easy to confuse.

5c. **Past** — lesson history, newest first, grouped by month, with horse, lesson type, outcome and what was charged. **Cancels and no-shows are included deliberately**: they're part of what the student was billed for, so omitting them would put the log at odds with their invoice. A summary separates the two counts (lessons ridden vs. total) and names how many were charged without riding. Opens on the most recent months with the rest one tap away — a year of weekly lessons is 80+ rows.

5e. **Agreements** — read-only, and always the **current** terms, since those are the ones that apply. There is no "what you signed" archive to show, and pretending otherwise would contradict the agreement itself. What the screen owes the rider instead is honesty about the mechanism:
   - **When they signed**, and whether the terms have moved since — with the coach's change note if so.
   - **What their own booking has already done**: *"You've booked 2 lessons since then, which accepts the updated terms"*, or, where they haven't, *"Booking your next lesson will accept the updated terms. If you'd rather not, don't book — and talk to your coach."* Stating this plainly is the difference between a mechanism and a trap. The clause is in a paragraph they ticked months ago; the consequence of their next tap should not be.
   - Where a signature is outstanding, this is where it's given: the current terms with a tick per section.
   - Where the coach has switched disclosures off but the rider signed previously, the signature date is still shown.

**Signing during profile creation** (screen 2) — the **included** sections appear inline with a checkbox each, above a line stating that **saving the profile is the signature**. Where the coach includes none, the block doesn't render and profile creation is unchanged. The acceptance is written in the same action that creates the profile, so a signature and the thing it attaches to can't come apart. For a rider under 18 the block says outright that the parent or guardian must be the one completing it and that the signature is theirs.

**When the terms change**, every rider gets a `disclosures_updated` alert carrying the coach's note and the line *"booking your next lesson accepts the updated terms."* **No Home banner and no booking gate** — there is nothing for the rider to action, and manufacturing a task would contradict the mechanism. The Home banner and the booking block exist for exactly one case: a rider who has **never** signed at all.


5d. **Profile** — year-to-date rides by horse (`rides_by_horse`), **their current rate and how it got there**, then profile fields as read-only, with an "Edit profile" action that reopens screen 2 pre-filled — same screen, not a separate one.

   The rate block is the student-facing half of frequency pricing and does two jobs. It states the standing discount with its cause and its date (*"$5 off every lesson since 1 August — you rode 9 times in July"*), and it states **what the next tier needs**: *"3 more rides this month and it's $10 off."* The second sentence is the entire reason frequency pricing exists — a discount the student can't see themselves earning rewards volume without encouraging it, which is half the coach's stated goal thrown away for the same money. Progress is shown against the current month's billable count so far, so it's a target rather than a verdict. Where the coach hasn't configured tiers, the block doesn't render; where the student is at the top tier, it says so and stops rather than inventing a further goal.

   **It also states the ratchet in plain words** — a rate holds for a month after a quieter one — because the reassurance is worth more than the rule is complicated. Without it, a student who knows their discount is usage-based reads any light month as a coming price rise. No-ride horses are shown but not student-editable; that stays the trainer's call (F1: set after their own assessment), shown here for transparency.

5e. **Message your coach** — free-form text, writing an open `Student_Notes` row with category `message`. Framed explicitly as **not a chat**: it lands on the coach's Alerts, and a reply comes by text or in person. The screen also lists everything the student has previously sent — including their `intro_lesson_no_fit` and `recurring_lesson_no_fit` notes, since those are the same thing from the coach's side — each showing whether it's still open or has been marked handled. This is also the closest Phase 1a analogue to an inbound SMS, so it doubles as a stand-in for what Phase 1b's NLU layer will parse.

**A price is never a bare number on any student screen.** Every lesson row, offer and confirmation shows its total with the breakdown either inline or one tap away — base, the band by name, the frequency discount, the offer discount. This is a product rule rather than a screen decision, and it is what the whole pricing model rests on: three adjustments that vary by slot, by student and by offer are *only* not confusing if the reason travels with the number everywhere it appears. A student comparing two lessons at $60 and $70 has an answer on screen instead of a text to write.

*Concretely, the surfaces this covers:*
- ***Home* (5a) and *Future* (5b) lesson rows** — collapsed to the total by default, so a week of lessons still scans as a list, with the breakdown one tap away. **These read the components stored on the row rather than recomputing**, which is the visible half of the stamped-at-creation rule: a lesson booked in August is quoted at August's rate even if the student's tier moves before they ride it. Recomputing on display would let a price the student was shown at booking quietly become a different one before the lesson happened, which is the exact surprise this design exists to prevent.
- **The recurring schedule list on *Future*** — the standing rate, quoted from the next generated occurrence rather than from the pattern, since a pattern deliberately carries no price of its own (Section 8). That's both the honest answer to *"what does my weekly lesson cost"* and the one that moves correctly when a tier changes.
- **Cancelled rows** say *"Not charged"* in place of a price where `is_billable` is false, and **the cancel confirmation carries the full breakdown** alongside the amount. A student about to be charged for a lesson they aren't riding is the likeliest moment in the product for *"why that amount?"*, and answering it before they ask is cheaper than the text that follows otherwise.
- **Past** (5c) reads the same stored components, so a lesson from March explains itself in March's terms however the bands have been re-cut since.

**A gap-fill offer names both prices and says why**, on Home and in the Phase 1b message alike: *"Thursday 4pm opened up — $55 instead of the usual $65, since I'd rather fill it."* Both figures, because a discount shown alone reads as the new price and sets the expectation that next week is $55 too; the reason, because a one-time discount without one is indistinguishable from a price cut. The offer's own screen also states that it's for this slot only.

**Cancellation from the student side** applies to any lesson row on Home or Future. One button, its type and billing decided by `cancel_disposition` (Section 10), with a confirmation sheet that names the horse, the actual charge if any, and — for a recurring occurrence — that only one week is affected and the pattern stays in place.

**Gaps this surfaces on the coach side, both deferred to when we're back there:** no screen yet for reviewing/approving a new profile (F1's trainer review/accept step), and no screen yet for the trainer to actually flip `recurring_potential_unlocked` after an intro lesson completes.

6. **Add recurring lesson** — same options-based pattern as "Pick your intro lesson" (screen 4), not a free-form picker: up to 10 candidates from `find_recurring_lesson_options`, each a day-of-week + time + horse combination. **The filter is stated on the screen, not left to be inferred:** a callout names the student's own target and potential windows as the source of the list, says that nothing outside them is shown even if the coach has the slot open, and notes the second constraint — a time only appears if it's free every week for the next four. Each option is badged Target or Potential, so a short list reads as an explanation rather than as the coach being booked solid. An "Edit my riding times" action goes straight to the fields that would widen it, since telling someone a filter is narrowing their results without offering a way to change it is a dead end. The student can select **one or two** (not just one — a student wanting two weekly lessons picks both), with a running "Selected: X of 2" count, then confirms to create a `Recurring_Bookings` row per selection. "None of these work for me" works exactly like the intro lesson's version: a note field, submitting creates an open `Student_Notes` row (category `recurring_lesson_no_fit`), surfacing on the coach's Alerts screen for later follow-up.
   **Confirming a recurring selection generates its `Bookings` rows immediately**, exactly as any other booking path would. An earlier build created only the `Recurring_Bookings` row, so a student's new standing lesson existed in the pattern table but appeared nowhere on the coach's Day view or Week Ahead — the coach's first sight of it would have been the student turning up. The pattern table is the source of truth for the *rule*; the schedule is only real once the occurrences exist.
6a. **Manage recurring lesson** (opened via "Change" on an existing pattern — which pattern was tapped is carried through, since a student may hold more than one) — shows the current day/time/horse, with three distinct actions: change horse, change day/time (each offering only combinations that hold for the next 4 occurrences, per `find_recurring_lesson_options`), or end the recurring lesson entirely. Any accepted change rewrites the pattern's future occurrences so the schedule and the pattern can't drift apart; past occurrences are untouched. Kept as separate actions rather than one combined "edit" — same reasoning as the coach's Booking detail screen: ending a series and changing one detail of it are different enough in consequence that conflating them risks a mistake.

---

## 14. Prototype Coverage

The clickable prototype is the working reference for Phase 1a, and this doc and it are kept in sync deliberately. Everything specified above is built and exercisable **except** the items below, listed so a gap stays a known gap rather than becoming a surprise during implementation.

**Specified here, not in the prototype — build work still to do:**
- *Horse detail:* the usage trend across recent weeks vs. cap, and the rest-day forecast strip across the rolling window. The prototype shows today's usage against the binding cap plus a single rest-forecast badge. Year-to-date rides by student **is** built.
- *Student profile (coach):* the 30-day exceptions view (deviations from the standing pattern — ad hoc additions, cancelled occurrences, occurrences awaiting an unconfirmed substitute). The prototype lists upcoming lessons in full instead, which reads fine at pilot volume but doesn't scale for a heavily-booked student.
- *`notification_preference` = `all`:* selectable on both profile forms, but not yet distinguished from `target_and_potential` anywhere it's read. See the `Students` schema note.
- *`Students` schema:* `email` and `guardian_email` are carried in the schema and collected by no screen. Neither is a safety field — the phone numbers are — so this can wait until there's a reason to email anyone.

**Known inconsistency, left deliberately:** `cancel_disposition` works in minutes to start time, while a booking still auto-completes once its whole *day* has passed. A lesson that ended at 6am today therefore shows no cancel button (correct — it has started) but doesn't yet count as a completed ride. Moving completion onto the clock is defensible and probably right, but it changes the coach's Day view and the ride tallies together, so it's worth doing on purpose rather than as a side effect.

- *Nightly pruning of expired `Student_Alerts`:* the prototype filters expired alerts out on read and never deletes them, which is the behaviour that matters. A cleanup job is a Sheets housekeeping concern.
- *Alert emit points:* wired for all eleven triggers listed in Section 13. Coach actions added later need their emit call added by hand — there's no mechanism that catches an omission.

**Pricing (new in v5) is built and exercisable**, with two notes worth carrying:
- *The monthly tier recompute has no clock to run on.* In Sheets it's a scheduled trigger on the 1st. The reachable trigger in the prototype is the coach editing either threshold on Lessons, which re-tiers every student against the new rule and emits `rate_changed` for anyone who moves. That isn't scaffolding — changing the rule genuinely has to reprice everyone, or the rule on screen and the rates being charged quietly disagree — but it means the passage of a month itself can't be observed.
- *Seed tiers are derived, not hand-written.* `earned_tier` runs the real two-month rule against the seeded history, so every stored tier is exactly what the monthly job would have written on 1 August, and the ratchet is demonstrable rather than asserted. Seeded history keeps the prices it was charged at — frequency pricing didn't exist then, and a past lesson's price is a fact, not a recalculation — while future occurrences are re-priced against the earned tier. The seed also deliberately trips the floor warning: at tier 2 in a weekday-morning band, the 60-minute private computes to $50 against a $55 floor, so the worked example's "discounts routinely hit the floor" caution is visible on first load rather than theoretical.

**Checks run against the prototype** — a bracket/syntax check, a **module load-order check** (a top-level `const` referencing one declared later throws at load and blanks the app — this caught a real crash that static text checks had missed for two revisions), a **load test that executes the whole data layer** with React stubbed, a **degenerate-input stress test** (no horses, no availability, deleted types, blank config, misconfigured tiers), and targeted suites for pricing, the Lessons/Schedule split, the band editor, student price surfaces, disclosures, and lesson-type roles. The lesson worth keeping: syntax and grep checks report green on a file that cannot load. Anything claiming the prototype works has to run it.

**Specified here, deliberately not simulatable in a prototype:**
- *Nightly generation of the rolling 4-week booking horizon* (Section 9). The prototype generates four occurrences when a pattern is created or edited; there's no scheduled trigger inside a browser.
- *`Message_Log`* — Phase 1b; there's no transport to log yet.
- *`Trainer_Config.prioritization_rule`* — feeds F7's optimization layer (Phase 3); nothing in Phase 1a reads it.

**Prototype-only, not product:**
- The Coach/Student role switch and the sign-out control on the student side.
- The simulated clock, pinned to Tue 8/18/2026 at 7:00 AM. It now carries a **time of day as well as a date** — `cancel_disposition` needs one, since a day-granular clock can't distinguish a lesson later today from one tomorrow morning. Date comparisons elsewhere are unchanged; the time is a separate value layered on top.
- The returning-student entry point on the welcome screen, which skips the credential check and drops straight into an established account. Nothing downstream can tell the difference from a typed login — it exists so the returning-student experience can be worked on without re-running onboarding.
- The seeded offer history, and the seeded **lesson history** behind each recurring pattern. History is generated from a per-pattern depth rather than hand-written: a returning student needs a plausible year behind them for ride counts and the Past tab to mean anything, and one pattern deliberately reaches back into the previous calendar year so the year-to-date cutoff is exercised rather than assumed. Every generated row is `completed`, which is invisible to the rest-day and usage-cap checks — those read `pending`/`confirmed` only — so seeded history can't perturb the welfare rules.
