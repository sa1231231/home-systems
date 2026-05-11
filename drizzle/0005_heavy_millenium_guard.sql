CREATE TABLE "daily_op_counters" (
	"operation" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_op_counters_operation_day_pk" PRIMARY KEY("operation","day")
);
