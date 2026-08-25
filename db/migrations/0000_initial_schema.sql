CREATE TYPE "public"."alert_kind" AS ENUM('lesson_cancelled', 'no_show', 'recurring_ended', 'lesson_moved', 'substitute_horse', 'recurring_changed', 'no_ride_changed', 'booking_created', 'recurring_created', 'offer', 'price_changed', 'rate_changed');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending', 'confirmed', 'completed', 'no_show', 'late_cancel', 'early_cancel');--> statement-breakpoint
CREATE TYPE "public"."day_of_week" AS ENUM('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');--> statement-breakpoint
CREATE TYPE "public"."experience_level" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."inactive_period_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('sms', 'web');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."note_category" AS ENUM('intro_lesson_no_fit', 'recurring_lesson_no_fit', 'message');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."notification_preference" AS ENUM('target_only', 'target_and_potential', 'all');--> statement-breakpoint
CREATE TYPE "public"."offer_response" AS ENUM('accepted', 'declined', 'no_response');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('pending_review', 'approved');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."riding_style" AS ENUM('English', 'Western');--> statement-breakpoint
CREATE TYPE "public"."riding_window_kind" AS ENUM('target', 'potential');--> statement-breakpoint
CREATE TYPE "public"."scheduling_preference" AS ENUM('back_to_back', 'spaced');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"recurring_id" uuid,
	"student_id" uuid NOT NULL,
	"horse_id" uuid NOT NULL,
	"lesson_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" "booking_status" DEFAULT 'pending' NOT NULL,
	"base_price" integer NOT NULL,
	"band_adjustment" integer DEFAULT 0 NOT NULL,
	"frequency_discount" integer DEFAULT 0 NOT NULL,
	"offer_discount" integer DEFAULT 0 NOT NULL,
	"manual_adjustment" integer DEFAULT 0 NOT NULL,
	"price" integer NOT NULL,
	"is_billable" boolean DEFAULT false NOT NULL,
	"is_new_student" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "bookings_end_after_start" CHECK ("bookings"."end_time" > "bookings"."start_time"),
	CONSTRAINT "bookings_discounts_non_negative" CHECK ("bookings"."frequency_discount" >= 0 and "bookings"."offer_discount" >= 0),
	CONSTRAINT "bookings_price_non_negative" CHECK ("bookings"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"horse_id" uuid NOT NULL,
	"lesson_type_id" uuid NOT NULL,
	"lesson_id" uuid,
	"kind" "riding_window_kind" NOT NULL,
	"offer_discount" integer,
	"offer_reason" text,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response" "offer_response",
	"rank" integer,
	CONSTRAINT "offers_one_per_student_slot" UNIQUE("student_id","date","start_time"),
	CONSTRAINT "offers_discount_non_negative" CHECK ("offers"."offer_discount" is null or "offers"."offer_discount" >= 0),
	CONSTRAINT "offers_rank_positive" CHECK ("offers"."rank" is null or "offers"."rank" >= 1)
);
--> statement-breakpoint
CREATE TABLE "recurring_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"horse_id" uuid NOT NULL,
	"lesson_type_id" uuid NOT NULL,
	"day_of_week" "day_of_week" NOT NULL,
	"start_time" time NOT NULL,
	"status" "recurring_status" DEFAULT 'active' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_bookings_end_after_start" CHECK ("recurring_bookings"."end_date" is null or "recurring_bookings"."end_date" >= "recurring_bookings"."start_date"),
	CONSTRAINT "recurring_bookings_ended_has_end_date" CHECK ("recurring_bookings"."status" = 'active' or "recurring_bookings"."end_date" is not null)
);
--> statement-breakpoint
CREATE TABLE "substitution_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"recurring_id" uuid,
	"booking_id" uuid,
	"substitute_horse_id" uuid NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "substitution_assignments_exactly_one_target" CHECK (num_nonnulls("substitution_assignments"."recurring_id", "substitution_assignments"."booking_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "disclosure_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_name" text NOT NULL,
	CONSTRAINT "disclosure_acceptances_student_key" UNIQUE("student_id")
);
--> statement-breakpoint
CREATE TABLE "disclosure_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "disclosure_sections_key_per_trainer" UNIQUE("trainer_id","key")
);
--> statement-breakpoint
CREATE TABLE "disclosures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"update_note" text NOT NULL,
	"first_published_at" timestamp with time zone,
	CONSTRAINT "disclosures_trainer_key" UNIQUE("trainer_id")
);
--> statement-breakpoint
CREATE TABLE "horse_inactive_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"horse_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"estimated_end_date" date,
	"actual_end_date" date,
	"status" "inactive_period_status" DEFAULT 'active' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "horse_inactive_periods_end_after_start" CHECK ("horse_inactive_periods"."actual_end_date" is null or "horse_inactive_periods"."actual_end_date" >= "horse_inactive_periods"."start_date"),
	CONSTRAINT "horse_inactive_periods_ended_has_actual_end" CHECK (("horse_inactive_periods"."status" = 'ended') = ("horse_inactive_periods"."actual_end_date" is not null))
);
--> statement-breakpoint
CREATE TABLE "horses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_experience_level" "experience_level" DEFAULT 'beginner' NOT NULL,
	"adult_only" boolean DEFAULT false NOT NULL,
	"riding_styles" "riding_style"[] DEFAULT '{}' NOT NULL,
	"max_rider_weight_lbs" integer,
	"rest_days_per_week" integer DEFAULT 1 NOT NULL,
	"max_daily_minutes_adult" integer,
	"max_daily_minutes_overall" integer,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "horses_rest_days_in_range" CHECK ("horses"."rest_days_per_week" >= 0 and "horses"."rest_days_per_week" <= 7),
	CONSTRAINT "horses_adult_cap_within_overall" CHECK ("horses"."max_daily_minutes_adult" is null
          or "horses"."max_daily_minutes_overall" is null
          or "horses"."max_daily_minutes_adult" <= "horses"."max_daily_minutes_overall")
);
--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_phone_key" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"timezone" text NOT NULL,
	"scheduling_preference" "scheduling_preference" DEFAULT 'spaced' NOT NULL,
	"min_buffer_min" integer DEFAULT 0 NOT NULL,
	"max_buffer_min" integer,
	"max_back_to_back" integer,
	"late_cancel_hours" integer DEFAULT 24 NOT NULL,
	"prioritization_rule" text,
	"frequency_tier1_min_rides" integer,
	"frequency_tier2_min_rides" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trainers_email_key" UNIQUE("email"),
	CONSTRAINT "trainers_tier_2_above_tier_1" CHECK ("trainers"."frequency_tier1_min_rides" is null
          or "trainers"."frequency_tier2_min_rides" is null
          or "trainers"."frequency_tier2_min_rides" > "trainers"."frequency_tier1_min_rides"),
	CONSTRAINT "trainers_buffers_non_negative" CHECK ("trainers"."min_buffer_min" >= 0
          and ("trainers"."max_buffer_min" is null or "trainers"."max_buffer_min" >= "trainers"."min_buffer_min")),
	CONSTRAINT "trainers_late_cancel_hours_positive" CHECK ("trainers"."late_cancel_hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "trainer_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"day_of_week" "day_of_week" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "trainer_availability_end_after_start" CHECK ("trainer_availability"."end_time" > "trainer_availability"."start_time")
);
--> statement-breakpoint
CREATE TABLE "trainer_time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trainer_time_off_end_after_start" CHECK ("trainer_time_off"."end_date" >= "trainer_time_off"."start_date")
);
--> statement-breakpoint
CREATE TABLE "lesson_type_band_adjustments" (
	"lesson_type_id" uuid NOT NULL,
	"band_id" uuid NOT NULL,
	"trainer_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "lesson_type_band_adjustments_lesson_type_id_band_id_pk" PRIMARY KEY("lesson_type_id","band_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_type_restricted_horses" (
	"lesson_type_id" uuid NOT NULL,
	"horse_id" uuid NOT NULL,
	CONSTRAINT "lesson_type_restricted_horses_lesson_type_id_horse_id_pk" PRIMARY KEY("lesson_type_id","horse_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"ride_time_min" integer NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"max_group_size" integer,
	"is_intro" boolean DEFAULT false NOT NULL,
	"base_price" integer NOT NULL,
	"min_price" integer NOT NULL,
	"max_price" integer NOT NULL,
	"frequency_discount1" integer,
	"frequency_discount2" integer,
	"gap_fill_discount" integer,
	"potential_lesson_eligible" boolean DEFAULT true NOT NULL,
	"riding_styles" "riding_style"[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_types_id_trainer_key" UNIQUE("id","trainer_id"),
	CONSTRAINT "lesson_types_ride_time_within_duration" CHECK ("lesson_types"."ride_time_min" > 0 and "lesson_types"."ride_time_min" <= "lesson_types"."duration_min"),
	CONSTRAINT "lesson_types_price_floor_below_ceiling" CHECK ("lesson_types"."min_price" <= "lesson_types"."max_price"),
	CONSTRAINT "lesson_types_prices_non_negative" CHECK ("lesson_types"."base_price" >= 0 and "lesson_types"."min_price" >= 0),
	CONSTRAINT "lesson_types_discounts_non_negative" CHECK (("lesson_types"."frequency_discount1" is null or "lesson_types"."frequency_discount1" >= 0)
          and ("lesson_types"."frequency_discount2" is null or "lesson_types"."frequency_discount2" >= 0)
          and ("lesson_types"."gap_fill_discount" is null or "lesson_types"."gap_fill_discount" >= 0)),
	CONSTRAINT "lesson_types_group_has_capacity" CHECK (("lesson_types"."is_group" and "lesson_types"."max_group_size" is not null and "lesson_types"."max_group_size" > 1)
          or (not "lesson_types"."is_group" and "lesson_types"."max_group_size" is null)),
	CONSTRAINT "lesson_types_group_never_potential" CHECK (not ("lesson_types"."is_group" and "lesson_types"."potential_lesson_eligible")),
	CONSTRAINT "lesson_types_intro_not_group" CHECK (not ("lesson_types"."is_intro" and "lesson_types"."is_group"))
);
--> statement-breakpoint
CREATE TABLE "price_band_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"band_id" uuid NOT NULL,
	"trainer_id" uuid NOT NULL,
	"day_of_week" "day_of_week" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "price_band_windows_end_after_start" CHECK ("price_band_windows"."end_time" > "price_band_windows"."start_time")
);
--> statement-breakpoint
CREATE TABLE "price_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_bands_id_trainer_key" UNIQUE("id","trainer_id")
);
--> statement-breakpoint
CREATE TABLE "student_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_no_ride_horses" (
	"student_id" uuid NOT NULL,
	"horse_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_no_ride_horses_student_id_horse_id_pk" PRIMARY KEY("student_id","horse_id")
);
--> statement-breakpoint
CREATE TABLE "student_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"category" "note_category" NOT NULL,
	"note" text NOT NULL,
	"status" "note_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_riding_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"kind" "riding_window_kind" NOT NULL,
	"day_of_week" "day_of_week" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	CONSTRAINT "student_riding_windows_end_after_start" CHECK ("student_riding_windows"."end_time" > "student_riding_windows"."start_time")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"auth_identity_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"guardian_name" text,
	"guardian_phone" text,
	"guardian_email" text,
	"guardian_relationship" text,
	"emergency_contact_name" text NOT NULL,
	"emergency_contact_phone" text NOT NULL,
	"age" integer NOT NULL,
	"experience_level" "experience_level" NOT NULL,
	"riding_styles" "riding_style"[] DEFAULT '{}' NOT NULL,
	"weight" integer,
	"notification_preference" "notification_preference" DEFAULT 'target_and_potential' NOT NULL,
	"frequency_tier" smallint DEFAULT 0 NOT NULL,
	"frequency_tier_effective_month" date,
	"profile_status" "profile_status" DEFAULT 'pending_review' NOT NULL,
	"recurring_potential_unlocked" boolean DEFAULT false NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_age_non_negative" CHECK ("students"."age" >= 0),
	CONSTRAINT "students_weight_positive" CHECK ("students"."weight" is null or "students"."weight" > 0),
	CONSTRAINT "students_frequency_tier_range" CHECK ("students"."frequency_tier" between 0 and 2),
	CONSTRAINT "students_tier_has_effective_month" CHECK ("students"."frequency_tier" = 0 or "students"."frequency_tier_effective_month" is not null),
	CONSTRAINT "students_effective_month_is_first_of_month" CHECK ("students"."frequency_tier_effective_month" is null
          or extract(day from "students"."frequency_tier_effective_month") = 1),
	CONSTRAINT "students_minor_has_guardian" CHECK ("students"."age" >= 18
          or ("students"."guardian_name" is not null and "students"."guardian_phone" is not null))
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trainer_id" uuid NOT NULL,
	"student_id" uuid,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_text" text NOT NULL,
	"related_lesson_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_recurring_id_recurring_bookings_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lesson_type_id_lesson_types_id_fk" FOREIGN KEY ("lesson_type_id") REFERENCES "public"."lesson_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_lesson_type_id_lesson_types_id_fk" FOREIGN KEY ("lesson_type_id") REFERENCES "public"."lesson_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_lesson_id_bookings_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_lesson_type_id_lesson_types_id_fk" FOREIGN KEY ("lesson_type_id") REFERENCES "public"."lesson_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_assignments" ADD CONSTRAINT "substitution_assignments_period_id_horse_inactive_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."horse_inactive_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_assignments" ADD CONSTRAINT "substitution_assignments_recurring_id_recurring_bookings_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_assignments" ADD CONSTRAINT "substitution_assignments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "substitution_assignments" ADD CONSTRAINT "substitution_assignments_substitute_horse_id_horses_id_fk" FOREIGN KEY ("substitute_horse_id") REFERENCES "public"."horses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_acceptances" ADD CONSTRAINT "disclosure_acceptances_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_sections" ADD CONSTRAINT "disclosure_sections_trainer_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."disclosures"("trainer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "horse_inactive_periods" ADD CONSTRAINT "horse_inactive_periods_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "horse_inactive_periods" ADD CONSTRAINT "horse_inactive_periods_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "horses" ADD CONSTRAINT "horses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainers" ADD CONSTRAINT "trainers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainer_availability" ADD CONSTRAINT "trainer_availability_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trainer_time_off" ADD CONSTRAINT "trainer_time_off_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_type_band_adjustments" ADD CONSTRAINT "lesson_type_band_adjustments_lesson_type_fk" FOREIGN KEY ("lesson_type_id","trainer_id") REFERENCES "public"."lesson_types"("id","trainer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_type_band_adjustments" ADD CONSTRAINT "lesson_type_band_adjustments_band_fk" FOREIGN KEY ("band_id","trainer_id") REFERENCES "public"."price_bands"("id","trainer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_type_restricted_horses" ADD CONSTRAINT "lesson_type_restricted_horses_lesson_type_id_lesson_types_id_fk" FOREIGN KEY ("lesson_type_id") REFERENCES "public"."lesson_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_type_restricted_horses" ADD CONSTRAINT "lesson_type_restricted_horses_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_types" ADD CONSTRAINT "lesson_types_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_band_windows" ADD CONSTRAINT "price_band_windows_band_fk" FOREIGN KEY ("band_id","trainer_id") REFERENCES "public"."price_bands"("id","trainer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_bands" ADD CONSTRAINT "price_bands_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_alerts" ADD CONSTRAINT "student_alerts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_no_ride_horses" ADD CONSTRAINT "student_no_ride_horses_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_no_ride_horses" ADD CONSTRAINT "student_no_ride_horses_horse_id_horses_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_notes" ADD CONSTRAINT "student_notes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_riding_windows" ADD CONSTRAINT "student_riding_windows_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_trainer_id_trainers_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."trainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_related_lesson_id_bookings_id_fk" FOREIGN KEY ("related_lesson_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_trainer_date_idx" ON "bookings" USING btree ("trainer_id","date");--> statement-breakpoint
CREATE INDEX "bookings_horse_date_idx" ON "bookings" USING btree ("horse_id","date");--> statement-breakpoint
CREATE INDEX "bookings_student_date_idx" ON "bookings" USING btree ("student_id","date");--> statement-breakpoint
CREATE INDEX "bookings_recurring_idx" ON "bookings" USING btree ("recurring_id","date");--> statement-breakpoint
CREATE INDEX "bookings_conversion_idx" ON "bookings" USING btree ("student_id","date","start_time");--> statement-breakpoint
CREATE INDEX "offers_trainer_date_idx" ON "offers" USING btree ("trainer_id","date");--> statement-breakpoint
CREATE INDEX "recurring_bookings_trainer_idx" ON "recurring_bookings" USING btree ("trainer_id","status");--> statement-breakpoint
CREATE INDEX "recurring_bookings_student_idx" ON "recurring_bookings" USING btree ("student_id","status");--> statement-breakpoint
CREATE INDEX "recurring_bookings_horse_idx" ON "recurring_bookings" USING btree ("horse_id","status");--> statement-breakpoint
CREATE INDEX "substitution_assignments_period_idx" ON "substitution_assignments" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "substitution_assignments_recurring_idx" ON "substitution_assignments" USING btree ("recurring_id");--> statement-breakpoint
CREATE INDEX "disclosure_acceptances_accepted_idx" ON "disclosure_acceptances" USING btree ("accepted_at");--> statement-breakpoint
CREATE INDEX "horse_inactive_periods_horse_idx" ON "horse_inactive_periods" USING btree ("horse_id","start_date");--> statement-breakpoint
CREATE INDEX "horses_account_idx" ON "horses" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "auth_codes_phone_idx" ON "auth_codes" USING btree ("phone","expires_at");--> statement-breakpoint
CREATE INDEX "trainer_availability_lookup_idx" ON "trainer_availability" USING btree ("trainer_id","day_of_week");--> statement-breakpoint
CREATE INDEX "trainer_time_off_lookup_idx" ON "trainer_time_off" USING btree ("trainer_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "lesson_types_trainer_idx" ON "lesson_types" USING btree ("trainer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_types_one_intro_per_trainer" ON "lesson_types" USING btree ("trainer_id") WHERE "lesson_types"."is_intro";--> statement-breakpoint
CREATE INDEX "price_band_windows_lookup_idx" ON "price_band_windows" USING btree ("trainer_id","day_of_week");--> statement-breakpoint
CREATE INDEX "price_bands_trainer_idx" ON "price_bands" USING btree ("trainer_id");--> statement-breakpoint
CREATE INDEX "student_alerts_feed_idx" ON "student_alerts" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "student_notes_open_idx" ON "student_notes" USING btree ("student_id","status","created_at");--> statement-breakpoint
CREATE INDEX "student_riding_windows_lookup_idx" ON "student_riding_windows" USING btree ("student_id","kind","day_of_week");--> statement-breakpoint
CREATE INDEX "students_trainer_idx" ON "students" USING btree ("trainer_id");--> statement-breakpoint
CREATE INDEX "students_identity_idx" ON "students" USING btree ("auth_identity_id");--> statement-breakpoint
CREATE INDEX "message_log_student_idx" ON "message_log" USING btree ("student_id","sent_at");--> statement-breakpoint
CREATE INDEX "message_log_trainer_idx" ON "message_log" USING btree ("trainer_id","sent_at");