import { z } from "zod";

export const mediaRenameSchema = z.object({
  display_name: z.string().trim().min(1).max(255)
});

