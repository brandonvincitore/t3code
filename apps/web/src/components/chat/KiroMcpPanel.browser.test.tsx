import type { KiroMcpStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { KiroMcpPanel } from "./KiroMcpPanel";

it("keeps the owner link available after an open failure and clears it after dismissal or completion", async () => {
  const status: KiroMcpStatus = {
    reported: true,
    canSignIn: true,
    busy: false,
    servers: [{ name: "company", status: "failed", failedAuthorization: true }],
    attempt: null,
  };
  const url = "https://login.example.test/authorize?state=synthetic";
  const open = vi.fn().mockRejectedValue(new Error("unavailable"));
  const cancel = vi.fn().mockResolvedValue(undefined);
  const element = (current = status) => (
    <KiroMcpPanel
      status={current}
      canManage
      isLocalEnvironment
      beginSignIn={async () => ({ attemptId: "owned" })}
      takeAuthorizationUrl={async () => ({ url })}
      cancelSignIn={cancel}
      openAuthorizationUrl={open}
      refresh={async () => {}}
    />
  );
  await using screen = await render(element());
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await userEvent.click(screen.getByRole("button", { name: "Sign in / reconnect" }));
  await expect.element(screen.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "Could not open the sign-in page. Copy the sign-in link or try opening it again.",
    );
  await userEvent.click(screen.getByRole("button", { name: "Copy sign-in link" }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Sign-in link copied.");
  expect(write).toHaveBeenCalledWith(url);
  await userEvent.click(screen.getByRole("button", { name: "Dismiss sign-in" }));
  await expect
    .element(screen.getByRole("button", { name: "Copy sign-in link" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Sign in / reconnect" }));
  await expect.element(screen.getByRole("button", { name: "Copy sign-in link" })).toBeVisible();
  await screen.rerender(
    element({
      ...status,
      servers: [{ name: "company", status: "connected", failedAuthorization: false }],
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Copy sign-in link" }))
    .not.toBeInTheDocument();
});
