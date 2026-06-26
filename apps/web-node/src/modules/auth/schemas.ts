import { z } from "zod";

const strongPassword = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, "Must contain a lowercase letter.")
  .regex(/[A-Z]/, "Must contain an uppercase letter.")
  .regex(/[0-9]/, "Must contain a number.");

export const registerSchema = z.object({
  email: z.email().max(320).transform((value) => value.toLowerCase()),
  display_name: z.string().trim().min(2).max(160),
  password: strongPassword
});

export const loginSchema = z.object({
  email: z.email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128)
});

export const forgotPasswordSchema = z.object({
  email: z.email().max(320).transform((value) => value.toLowerCase())
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: strongPassword
});

export const impersonationSchema = z.object({
  target_user_id: z.uuid(),
  reason: z.string().trim().min(10).max(500)
});
