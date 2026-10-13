import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  wildcardDispatchFixture,
  wildcardReplayAuthorizationFixture,
} from "../support/inbound-wildcard-fixture";

describe("wildcard CTWA dispatch and retained history", () => {
  it.each(["wildcard", "optional destination", "explicit"])(
    "selects a historical %s canary through the existing authorization service",
    async (kind) => {
      const h = wildcardReplayAuthorizationFixture();
      if (kind === "optional destination")
        h.route.metaConversionDestinationId = null;
      if (kind === "explicit") h.route.metaReportingAccountId = "account-1";
      expect(
        await h.replay.authorizeReplay(
          "connection",
          "fixture",
          "canary_1",
          "channel",
          { id: "owner", role: "platform_owner" },
          null,
        ),
      ).toMatchObject({ status: "queued", totalItems: 1 });
      expect(h.prisma.inboundWebhookReplayItem.createMany).toHaveBeenCalledWith(
        {
          data: [
            {
              workspaceId: "ws",
              batchId: "batch",
              eventId: "event",
              status: "queued",
            },
          ],
          skipDuplicates: true,
        },
      );
      expect(h.replayQueue.enqueueBatch).toHaveBeenCalledWith({
        workspaceId: "ws",
        batchId: "batch",
      });
      await expect(
        h.replay.authorizeReplay(
          "connection",
          "fixture",
          "canary_1",
          "channel",
          { id: "owner", role: "platform_owner" },
          null,
        ),
      ).rejects.toThrow("Esta conexao ja possui um replay em andamento");
    },
  );

  it("refuses a historical canary after destination authorization is revoked", async () => {
    const h = wildcardReplayAuthorizationFixture();
    h.route.metaReportingAccountId = "account-1";
    h.accounts[0].allowedDestinations = [];
    await expect(
      h.replay.authorizeReplay(
        "connection",
        "fixture",
        "canary_1",
        "channel",
        { id: "owner", role: "platform_owner" },
        null,
      ),
    ).rejects.toThrow(
      "Nenhum evento possui rota completa e payload disponivel",
    );
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it("rejects a canary when the duplicate insert claims no event", async () => {
    const h = wildcardReplayAuthorizationFixture();
    h.prisma.inboundWebhookReplayItem.createMany.mockResolvedValue({
      count: 0,
    });
    await expect(
      h.replay.authorizeReplay(
        "connection",
        "fixture",
        "canary_1",
        "channel",
        { id: "owner", role: "platform_owner" },
        null,
      ),
    ).rejects.toThrow("Os eventos elegiveis ja pertencem a outro replay");
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it.each(["wildcard", "optional destination", "explicit"])(
    "materializes %s through production with concrete authorized IDs",
    async (kind) => {
      const h = wildcardDispatchFixture();
      if (kind === "optional destination")
        h.route.metaConversionDestinationId = null;
      if (kind === "explicit") h.route.metaReportingAccountId = "account-1";
      await expect(
        h.production.processItem({
          workspaceId: "ws",
          productionItemId: "item",
        }),
      ).resolves.toEqual({ status: "materialized" });
      expect(h.conversions.recordExternalConversion).toHaveBeenCalledWith(
        expect.objectContaining({
          metaBusinessConnectionId: "bm",
          metaAccountId: "act-1",
          metaConversionDestinationId: "dest",
          dedupeKey: `inbound-webhook:connection:${h.event.dedupeKey}`,
        }),
      );
      await expect(
        h.production.processItem({
          workspaceId: "ws",
          productionItemId: "item",
        }),
      ).resolves.toEqual({ status: "unchanged" });
      expect(h.conversions.recordExternalConversion).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts retained pre-activation CTWA in the existing replay worker, once", async () => {
    const h = wildcardDispatchFixture();
    h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    // Exercise the existing worker item boundary; no new student endpoint.
    await (h.replay as any).processItem("batch", "ws", "item");
    expect(h.item.status).toBe("materialized");
    await (h.replay as any).processItem("batch", "ws", "item");
    expect(h.conversions.recordExternalConversion).toHaveBeenCalledTimes(1);
  });

  it("reevaluates retained CTWA after activation without creating historical sends", async () => {
    const h = wildcardDispatchFixture();
    h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    expect(await h.routes.reevaluateOpenEvents("ws", "channel")).toMatchObject({
      resolvedCount: 1,
    });
    expect(h.channel.routes).toHaveLength(1);
    expect(
      await h.intake.enqueueDelivery({
        workspaceId: "ws",
        connectionId: "connection",
        deliveryId: "delivery",
      }),
    ).toMatchObject({ eligible: 0, persisted: 0 });
    expect(
      h.prisma.inboundWebhookProductionItem.createMany,
    ).not.toHaveBeenCalled();
    expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    expect(await h.intake.recoverPendingItems()).toMatchObject({ eligible: 0 });
  });

  it("recovers an existing queued production item through the existing queue", async () => {
    const h = wildcardDispatchFixture();
    h.prisma.inboundWebhookProductionItem.findMany.mockResolvedValue([
      { id: "item", workspaceId: "ws" },
    ]);
    expect(await h.intake.recoverPendingItems()).toMatchObject({
      eligible: 1,
      queued: 1,
    });
    expect(h.queue.enqueueItem).toHaveBeenCalledWith({
      productionItemId: "item",
      workspaceId: "ws",
    });
  });

  it.each(["production", "replay"])(
    "%s refuses revoked authorization even with a retained resolved event",
    async (mode) => {
      const h = wildcardDispatchFixture();
      h.route.metaReportingAccountId = "account-1";
      h.accounts[0].allowedDestinations = [];
      if (mode === "replay")
        h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
      if (mode === "production")
        await expect(
          h.production.processItem({
            workspaceId: "ws",
            productionItemId: "item",
          }),
        ).rejects.toMatchObject({
          code: "inbound_webhook_production_route_invalid",
        });
      else {
        await (h.replay as any).processItem("batch", "ws", "item");
        expect(h.item.errorCode).toBe("inbound_webhook_replay_route_invalid");
      }
      expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
      expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    },
  );

  it("readiness rechecks asset eligibility instead of trusting stale validation", async () => {
    const h = wildcardDispatchFixture();
    h.business.credential.status = "revoked";
    const [channel] = await h.routes.listChannels("ws", "connection");
    expect(channel.readiness).toMatchObject({
      validRouteCount: 0,
      state: "blocked",
    });
  });

  it("preview counts the authorized historical wildcard but rejects revoked access", async () => {
    const h = wildcardDispatchFixture();
    h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    expect(await h.replay.getPreview("connection")).toMatchObject({
      counts: { routeResolved: 1, eligible: 1 },
    });
    h.accounts[0].allowedDestinations = [];
    expect(await h.replay.getPreview("connection")).toMatchObject({
      counts: { routeResolved: 0, eligible: 0 },
    });
  });

  it("keeps the student replay flag disabled and its authorization closed", async () => {
    const h = wildcardDispatchFixture();
    h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "false";
    await expect(
      h.replay.authorizeReplay(
        "connection",
        "fixture",
        "canary_1",
        "channel",
        { id: "owner", role: "platform_owner" },
        null,
      ),
    ).rejects.toThrow("Replay controlado desativado neste ambiente");
    expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
  });

  it("does not learn extra routes when an operator route restricts the destination", async () => {
    const h = wildcardDispatchFixture();
    h.route.metaConversionDestinationId = "unconfigured-other";
    expect(await h.routes.reevaluateOpenEvents("ws", "channel")).toMatchObject({
      resolvedCount: 0,
      unresolvedCount: 1,
    });
    expect(h.channel.routes).toHaveLength(1);
    expect(h.prisma.inboundWebhookChannelRoute.findMany).not.toHaveBeenCalled();
  });

  it.each([
    "BM inactive",
    "credential inactive",
    "credential other tenant",
    "account inactive",
    "account other BM",
    "destination inactive",
    "destination other tenant",
    "ambiguous destination",
    "inactive route",
    "invalid route",
    "explicit account mismatch",
    "route other tenant",
    "parser observation",
    "parser retired",
    "payload expired",
  ])(
    "blocks dispatch and replay for %s before materializing",
    async (reason) => {
      for (const mode of ["production", "replay"]) {
        const h = wildcardDispatchFixture();
        if (mode === "replay")
          h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
        if (reason === "BM inactive") h.business.status = "inactive";
        if (reason === "credential inactive")
          h.business.credential.status = "revoked";
        if (reason === "credential other tenant")
          h.business.credential.workspaceId = "other";
        if (reason === "account inactive") h.accounts[0].active = false;
        if (reason === "account other BM")
          h.accounts[0].businessConnectionId = "other";
        if (reason === "destination inactive")
          h.destination.status = "inactive";
        if (reason === "destination other tenant")
          h.destination.workspaceId = "other";
        if (reason === "ambiguous destination")
          h.accounts[0].allowedDestinations.push({
            workspaceId: "ws",
            active: true,
            conversionDestinationId: "dest-2",
          });
        if (reason === "inactive route") h.route.active = false;
        if (reason === "invalid route") h.route.validationStatus = "invalid";
        if (reason === "explicit account mismatch")
          h.route.metaReportingAccountId = "account-2";
        if (reason === "route other tenant") h.route.workspaceId = "other";
        if (reason === "parser observation")
          h.connection.parserRelease.status = "observation_only";
        if (reason === "parser retired")
          h.connection.parserRelease.status = "retired";
        if (reason === "payload expired")
          h.delivery.payloadExpiresAt = new Date(Date.now() - 1);
        if (mode === "production")
          await expect(
            h.production.processItem({
              workspaceId: "ws",
              productionItemId: "item",
            }),
          ).rejects.toHaveProperty("code");
        else {
          await (h.replay as any).processItem("batch", "ws", "item");
          expect(h.item.status).toBe("failed");
        }
        expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
        expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
        expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
      }
    },
  );

  it("reuses the same conversion dedupe identity across live and historical workers", async () => {
    const live = wildcardDispatchFixture();
    const historical = wildcardDispatchFixture();
    historical.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    historical.conversions.recordExternalConversion.mockResolvedValue({
      status: "duplicate",
      conversionEventLogId: "conversion",
      deliveryStatus: "sent",
    });
    await live.production.processItem({
      workspaceId: "ws",
      productionItemId: "item",
    });
    await (historical.replay as any).processItem("batch", "ws", "item");
    expect(historical.item.status).toBe("duplicate");
    expect(
      historical.conversions.recordExternalConversion.mock.calls[0][0],
    ).toMatchObject({
      dedupeKey:
        live.conversions.recordExternalConversion.mock.calls[0][0].dedupeKey,
      eventId:
        live.conversions.recordExternalConversion.mock.calls[0][0].eventId,
    });
    expect(historical.conversionQueue.enqueueSend).not.toHaveBeenCalled();
  });
});
