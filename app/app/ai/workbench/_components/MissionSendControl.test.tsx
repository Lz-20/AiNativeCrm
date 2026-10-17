import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionSendControl } from "./MissionSendControl";
const mission = { id: "mission-1", status: "running", customer_send_paused: false };
afterEach(() => vi.unstubAllGlobals());
describe("durable Mission send controls (offline)", () => {
  it("records an explicit reason and suppresses repeated clicks while awaiting the server", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    render(<MissionSendControl mission={mission} onUpdated={onUpdated} />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "暂停客户发送" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("发送策略调整原因"), "先核对最新报价");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      command: "pause_customer_send",
      reason: "先核对最新报价",
      requestKey: expect.any(String),
    });
    finish(new Response(JSON.stringify({ data: { customerSendPaused: true } })));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(true));
  });
  it("retains the idempotency key after an uncertain response and does not fake a paused state", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { customerSendPaused: true } })));
    vi.stubGlobal("fetch", fetch);
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    render(<MissionSendControl mission={mission} onUpdated={onUpdated} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("发送策略调整原因"), "先核对最新报价");
    await user.click(screen.getByRole("button", { name: "暂停客户发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(onUpdated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "暂停客户发送" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(true));
    expect(fetch.mock.calls[0]![1].body).toEqual(fetch.mock.calls[1]![1].body);
  });
  it("resumes only customer sending and hides controls for completed missions", () => {
    const { rerender } = render(
      <MissionSendControl
        mission={{ ...mission, customer_send_paused: true }}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复客户发送" })).toBeInTheDocument();
    expect(screen.getByText(/旧审批不会复活/)).toBeInTheDocument();
    rerender(
      <MissionSendControl mission={{ ...mission, status: "completed" }} onUpdated={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
