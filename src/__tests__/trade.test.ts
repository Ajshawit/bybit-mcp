import { handlePlaceTrade, handleClosePosition, handleManagePosition } from "../tools/trade";
import { BybitClient } from "../client";

jest.mock("../client");
jest.mock("../tools/trade-perp");
jest.mock("../tools/trade-spot");

import { handlePlacePerp, handleClosePerp, handleManagePosition as managePerp } from "../tools/trade-perp";
import { handlePlaceSpot, handleCloseSpot } from "../tools/trade-spot";

const MockClient = BybitClient as jest.MockedClass<typeof BybitClient>;
const mockPlacePerp = handlePlacePerp as jest.Mock;
const mockPlaceSpot = handlePlaceSpot as jest.Mock;
const mockClosePerp = handleClosePerp as jest.Mock;
const mockCloseSpot = handleCloseSpot as jest.Mock;
const mockManagePerp = managePerp as jest.Mock;

describe("handlePlaceTrade dispatcher", () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes linear (default) to handlePlacePerp", async () => {
    mockPlacePerp.mockResolvedValue({ orderId: "p1" });
    const client = new MockClient("k", "s", "u");

    await handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5, sl: 29000 });

    expect(mockPlacePerp).toHaveBeenCalledWith(client, expect.objectContaining({ symbol: "BTCUSDT", category: "linear" }));
    expect(mockPlaceSpot).not.toHaveBeenCalled();
  });

  it("routes inverse to handlePlacePerp", async () => {
    mockPlacePerp.mockResolvedValue({ orderId: "p2" });
    const client = new MockClient("k", "s", "u");

    await handlePlaceTrade(client, { symbol: "BTCUSD", side: "Buy", margin: 0.01, leverage: 10, sl: 29000, category: "inverse" });

    expect(mockPlacePerp).toHaveBeenCalledWith(client, expect.objectContaining({ category: "inverse" }));
  });

  it("routes spot to handlePlaceSpot", async () => {
    mockPlaceSpot.mockResolvedValue({ orderId: "s1" });
    const client = new MockClient("k", "s", "u");

    await handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", margin: 100, category: "spot" });

    expect(mockPlaceSpot).toHaveBeenCalledWith(client, expect.objectContaining({ category: "spot" }));
    expect(mockPlacePerp).not.toHaveBeenCalled();
  });

  it("routes spot_margin to handlePlaceSpot", async () => {
    mockPlaceSpot.mockResolvedValue({ orderId: "s2" });
    const client = new MockClient("k", "s", "u");

    await handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", margin: 100, category: "spot_margin" });

    expect(mockPlaceSpot).toHaveBeenCalledWith(client, expect.objectContaining({ category: "spot_margin" }));
  });

  it("throws if leverage missing for perp", async () => {
    const client = new MockClient("k", "s", "u");

    await expect(
      handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, sl: 29000 } as any)
    ).rejects.toMatchObject({ message: expect.stringContaining("leverage is required") });
  });

  it("throws if sl missing for perp", async () => {
    const client = new MockClient("k", "s", "u");

    await expect(
      handlePlaceTrade(client, { symbol: "BTCUSDT", side: "Buy", margin: 10, leverage: 5 } as any)
    ).rejects.toMatchObject({ message: expect.stringContaining("sl is required") });
  });
});

describe("handleClosePosition dispatcher", () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes linear to handleClosePerp", async () => {
    mockClosePerp.mockResolvedValue({ orderId: "c1" });
    const client = new MockClient("k", "s", "u");

    await handleClosePosition(client, { symbol: "BTCUSDT", side: "Buy" });

    expect(mockClosePerp).toHaveBeenCalled();
    expect(mockCloseSpot).not.toHaveBeenCalled();
  });

  it("routes spot to handleCloseSpot", async () => {
    mockCloseSpot.mockResolvedValue({ orderId: "c2" });
    const client = new MockClient("k", "s", "u");

    await handleClosePosition(client, { symbol: "BTCUSDT", side: "Buy", category: "spot" });

    expect(mockCloseSpot).toHaveBeenCalled();
    expect(mockClosePerp).not.toHaveBeenCalled();
  });
});

describe("handleManagePosition", () => {
  it("delegates to perp handler", async () => {
    mockManagePerp.mockResolvedValue({ updated: true });
    const client = new MockClient("k", "s", "u");

    await handleManagePosition(client, { symbol: "BTCUSDT", side: "Buy", updates: { sl: 29000 } });

    expect(mockManagePerp).toHaveBeenCalled();
  });
});
