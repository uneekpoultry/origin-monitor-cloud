"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://originmonitor.com";

export async function sendPasswordResetEmail(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  if (!authUser.user?.email) {
    return { error: "User has no email address." };
  }

  const { error } = await admin.auth.resetPasswordForEmail(
    authUser.user.email,
    { redirectTo: `${SITE_URL}/auth/callback?next=/reset-password` },
  );
  if (error) return { error: error.message };
  return { ok: true, message: `Reset email sent to ${authUser.user.email}` };
}

export async function setUserPassword(userId: string, newPassword: string) {
  await requireAdmin();
  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (error) return { error: error.message };

  revalidatePath(`/admin/users/${userId}`);
  return { ok: true, message: "Password updated. Share it with the customer." };
}

export async function confirmUserEmail(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    email_confirm: true,
  });
  if (error) return { error: error.message };

  revalidatePath(`/admin/users/${userId}`);
  return { ok: true, message: "Email marked as confirmed." };
}

export async function toggleAdmin(userId: string, makeAdmin: boolean) {
  const { user: me } = await requireAdmin();
  if (me.id === userId && !makeAdmin) {
    return { error: "You can't remove admin from your own account." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ is_admin: makeAdmin })
    .eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/users/${userId}`);
  return {
    ok: true,
    message: makeAdmin ? "User is now an admin." : "Admin removed.",
  };
}

export async function deleteUser(userId: string) {
  const { user: me } = await requireAdmin();
  if (me.id === userId) {
    return { error: "You can't delete your own account." };
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return { error: error.message };

  revalidatePath("/admin/users");
  redirect("/admin/users");
}

export async function updateProfile(
  userId: string,
  updates: { full_name?: string; phone?: string; country?: string },
) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update(updates).eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/users/${userId}`);
  return { ok: true, message: "Profile updated." };
}
