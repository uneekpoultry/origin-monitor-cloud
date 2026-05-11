"use client";

import { useState, useTransition } from "react";
import {
  confirmUserEmail,
  deleteUser,
  sendPasswordResetEmail,
  setUserPassword,
  toggleAdmin,
} from "./actions";

type Props = {
  userId: string;
  userEmail: string;
  isAdmin: boolean;
  isEmailConfirmed: boolean;
};

export function UserActionsPanel({
  userId,
  userEmail,
  isAdmin,
  isEmailConfirmed,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showPasswordField, setShowPasswordField] = useState(false);

  function show(result: { ok?: boolean; error?: string; message?: string }) {
    if (result.error) setMessage({ tone: "err", text: result.error });
    else if (result.message) setMessage({ tone: "ok", text: result.message });
  }

  return (
    <div className="card space-y-4">
      <h2 className="text-lg font-semibold">Actions</h2>

      <ActionRow
        label="Send password reset email"
        description="Supabase emails the user a link to set a new password."
        button="Send"
        onClick={() =>
          startTransition(async () =>
            show(await sendPasswordResetEmail(userId)),
          )
        }
        pending={pending}
      />

      <div className="border-t border-white/5 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Set a password manually</p>
            <p className="mt-1 text-xs text-white/50">
              Use when the customer can't access their inbox. Tell them to
              change it immediately.
            </p>
          </div>
          <button
            onClick={() => setShowPasswordField((v) => !v)}
            className="btn-ghost shrink-0"
          >
            {showPasswordField ? "Cancel" : "Set password"}
          </button>
        </div>
        {showPasswordField && (
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              placeholder="New password (min 8 chars)"
              className="input flex-1"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              onClick={() =>
                startTransition(async () => {
                  const r = await setUserPassword(userId, newPassword);
                  if (r.ok) {
                    setNewPassword("");
                    setShowPasswordField(false);
                  }
                  show(r);
                })
              }
              className="btn-primary"
              disabled={pending || newPassword.length < 8}
            >
              Save
            </button>
          </div>
        )}
      </div>

      {!isEmailConfirmed && (
        <ActionRow
          label="Confirm email manually"
          description="Marks the email as verified without a click-through."
          button="Confirm"
          onClick={() =>
            startTransition(async () => show(await confirmUserEmail(userId)))
          }
          pending={pending}
        />
      )}

      <ActionRow
        label={isAdmin ? "Remove admin access" : "Grant admin access"}
        description={
          isAdmin
            ? "User will no longer see /admin."
            : "User can manage all customers and devices."
        }
        button={isAdmin ? "Revoke" : "Grant"}
        tone={isAdmin ? "warn" : "ok"}
        onClick={() =>
          startTransition(async () =>
            show(await toggleAdmin(userId, !isAdmin)),
          )
        }
        pending={pending}
      />

      <div className="border-t border-white/5 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-red-300">Delete user</p>
            <p className="mt-1 text-xs text-white/50">
              Permanent. Removes their account, sensors, readings, hatch logs.
            </p>
          </div>
          <button
            onClick={() => {
              if (
                confirm(
                  `Delete ${userEmail} permanently? This cannot be undone.`,
                )
              ) {
                startTransition(async () => {
                  await deleteUser(userId);
                });
              }
            }}
            className="btn-ghost shrink-0 border-red-500/30 text-red-300 hover:bg-red-500/10"
            disabled={pending}
          >
            Delete
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            message.tone === "ok"
              ? "border-light/30 bg-light/10 text-light"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

function ActionRow({
  label,
  description,
  button,
  onClick,
  pending,
  tone = "ok",
}: {
  label: string;
  description: string;
  button: string;
  onClick: () => void;
  pending: boolean;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-white/5 pt-4 first:border-t-0 first:pt-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs text-white/50">{description}</p>
      </div>
      <button
        onClick={onClick}
        className={tone === "warn" ? "btn-ghost shrink-0" : "btn-primary shrink-0"}
        disabled={pending}
      >
        {button}
      </button>
    </div>
  );
}
