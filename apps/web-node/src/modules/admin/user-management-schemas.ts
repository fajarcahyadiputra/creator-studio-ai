import { z } from "zod";

const userStatusEnum = z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "DISABLED"]);

const strongPassword = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, "Must contain a lowercase letter.")
  .regex(/[A-Z]/, "Must contain an uppercase letter.")
  .regex(/[0-9]/, "Must contain a number.");

function optionalCodeField(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .transform((value) => value || undefined);
}

export const adminCreateUserSchema = z.object({
  email: z.email().max(320).transform((value) => value.toLowerCase()),
  display_name: z.string().trim().min(2).max(160),
  password: strongPassword,
  status: userStatusEnum.default("ACTIVE"),
  plan_code: optionalCodeField(80),
  role_codes_csv: optionalCodeField(500)
});

export const adminUpdateUserSchema = z.object({
  email: z.email().max(320).transform((value) => value.toLowerCase()),
  display_name: z.string().trim().min(2).max(160),
  status: userStatusEnum,
  plan_code: optionalCodeField(80),
  role_codes_csv: optionalCodeField(500)
});

