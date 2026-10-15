import { STRICT_POSTURE } from "../posture.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { resolveBudget, resolveFleetWaveGapMs, resolveMode, resolveTailAllowance, resolveTailMaxBytes, resolveZeroDispatchMaxBytes, resolveZeroDispatchWrites } from "./config.mjs";
import { MAIN_LANE, OUT_OF_WORKSPACE_EXEMPTION, TAIL_ALLOWANCE_ADVISORY_MESSAGE_SLUG, TAIL_ALLOW_AUDIT_EVENT, UNVERIFIED_ADVISORY_MESSAGE_SLUG, WRITE_BUDGET_ADVISORY_MESSAGE_SLUG, WRITE_BUDGET_DENY_MESSAGE_SLUG, WRITE_TOOLS, ZERO_DISPATCH_ADVISORY_MESSAGE_SLUG, ZERO_DISPATCH_SOFTENED_AUDIT_EVENT } from "./constants.mjs";
import { extractToolUseId, totalDispatches } from "./dispatch.mjs";
import { claimAdvisory, normalizeState, readState, stableAdvisorySignature, withStateLock, writeState } from "./state.mjs";
import { advisoryOutput, budgetMultiple, buildAdvisoryLine, buildTailAllowanceAdvisory, buildUnverifiedAdvisory, buildZeroDispatchAdvisory, denyOutput, editReplacementBytes, extractAuditWritePath, extractWritePath, inlineWriteBytes, isWorkspaceWritePath, writePathSignature } from "./write.mjs";

function handleWrite(input, env, { sessionId, toolName, file, now, posture, cwd, writeHookText }) {
  if (!WRITE_TOOLS.has(toolName)) {
    return;
  }

  const toolUseId = extractToolUseId(input);
  if (input.hook_event_name === "PostToolUseFailure" || input.hook_event_name === "PostToolUse") {
    if (!toolUseId) return;
    withStateLock(file, () => {
      const state = normalizeState(readState(file), now, resolveFleetWaveGapMs(env));
      const index = state.pendingWrites.findIndex((entry) => entry.id === toolUseId && entry.tool === toolName);
      if (index < 0) return;
      const [entry] = state.pendingWrites.splice(index, 1);
      if (input.hook_event_name === "PostToolUse" && entry.epoch === state.dispatchEpoch && !state.confirmedPathSignatures.includes(entry.signature)) {
        state.confirmedPathSignatures.push(entry.signature);
      }
      if (input.hook_event_name === "PostToolUseFailure") {
        state.writeCount = Math.max(0, state.writeCount - 1);
        state.inlineWriteBytes = Math.max(0, state.inlineWriteBytes - entry.bytes);
        if (entry.epoch === state.dispatchEpoch) {
          state.writesSinceDispatch = Math.max(0, state.writesSinceDispatch - 1);
          if (entry.tail) state.tailWritesSinceDispatch = Math.max(0, state.tailWritesSinceDispatch - 1);
          if (!state.confirmedPathSignatures.includes(entry.signature) && !state.pendingWrites.some((other) => other.epoch === entry.epoch && other.signature === entry.signature)) {
            state.writtenPathSignatures = state.writtenPathSignatures.filter((value) => value !== entry.signature);
          }
          const budget = resolveBudget(env);
          state.advisedMultiples = state.advisedMultiples.filter((multiple) => multiple * budget <= state.writesSinceDispatch);
          delete state.advisorySignatures["write-budget"];
        }
      }
      writeState(file, state);
    });
    return;
  }
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return;

  const targetPath = extractWritePath(input.tool_input);
  if (!isWorkspaceWritePath(targetPath, cwd)) {
    recordAuditEvent(
      { at: now, session: sessionId, event: "write", lane: MAIN_LANE, tool: toolName, exempt: OUT_OF_WORKSPACE_EXEMPTION },
      env
    );
    return;
  }

  const auditPath = extractAuditWritePath(targetPath, cwd);
  const budget = resolveBudget(env);
  const mode = resolveMode(env);
  const writeBytes = inlineWriteBytes(input.tool_input);
  const replacementBytes = toolName === "Edit" ? editReplacementBytes(input.tool_input) : null;
  const pathSignature = writePathSignature(targetPath, cwd);
  const tailMaxBytes = resolveTailMaxBytes(env);
  const tailAllowance = resolveTailAllowance(env);
  const zeroDispatchMaxBytes = resolveZeroDispatchMaxBytes(env);
  const zeroDispatchWrites = resolveZeroDispatchWrites(env);
  const decision = withStateLock(file, () => {
    const state = normalizeState(readState(file), now, resolveFleetWaveGapMs(env));
    if (toolUseId && state.pendingWrites.some((entry) => entry.id === toolUseId && entry.tool === toolName)) return { duplicate: true };
    const dispatchCount = totalDispatches(state.dispatches);
    let relief = null;
    if (mode === "enforce" && state.writesSinceDispatch >= budget) {
      const tailAllowed =
        toolName === "Edit" &&
        replacementBytes !== null &&
        replacementBytes <= tailMaxBytes &&
        tailAllowance > 0 &&
        state.tailWritesSinceDispatch < tailAllowance &&
        state.writtenPathSignatures.includes(pathSignature);
      const zeroDispatchAllowed =
        !tailAllowed &&
        dispatchCount === 0 &&
        state.writeCount < zeroDispatchWrites &&
        state.inlineWriteBytes + writeBytes < zeroDispatchMaxBytes;
      if (!tailAllowed && !zeroDispatchAllowed) {
        return { denied: true, writeCount: state.writesSinceDispatch, dispatchCount };
      }
      relief = tailAllowed ? TAIL_ALLOW_AUDIT_EVENT : ZERO_DISPATCH_SOFTENED_AUDIT_EVENT;
    }
    state.writeCount += 1;
    state.writesSinceDispatch += 1;
    state.inlineWriteBytes += writeBytes;
    const newPath = !state.writtenPathSignatures.includes(pathSignature);
    if (newPath) {
      state.writtenPathSignatures.push(pathSignature);
    }
    if (relief === TAIL_ALLOW_AUDIT_EVENT) {
      state.tailWritesSinceDispatch += 1;
    }
    if (toolUseId) state.pendingWrites.push({ id: toolUseId, tool: toolName, epoch: state.dispatchEpoch, bytes: writeBytes, signature: pathSignature, tail: relief === TAIL_ALLOW_AUDIT_EVENT });
    const multiple = budgetMultiple(state.writesSinceDispatch, budget);
    let candidate = null;
    if (
      multiple >= 1 &&
      (posture === STRICT_POSTURE || (state.writesSinceDispatch === multiple * budget && Number.isInteger(Math.log2(multiple)))) &&
      !state.advisedMultiples.includes(multiple)
    ) {
      state.advisedMultiples.push(multiple);
      if (!relief) {
        candidate = { multiple, writeCount: state.writesSinceDispatch, dispatchEpoch: state.dispatchEpoch };
      }
    }
    writeState(file, state);
    return {
      denied: false,
      writeCount: state.writesSinceDispatch,
      dispatchCount,
      candidate,
      relief,
      dispatchEpoch: state.dispatchEpoch,
      remainingTailSlots: tailAllowance - state.tailWritesSinceDispatch,
      remainingZeroDispatchWrites: Math.max(0, zeroDispatchWrites - state.writeCount),
      remainingZeroDispatchBytes: Math.max(0, zeroDispatchMaxBytes - state.inlineWriteBytes)
    };
  });

  if (decision.duplicate) return;

  if (decision.denied) {
    recordAuditEvent(
      {
        at: now,
        session: sessionId,
        event: "deny",
        lane: MAIN_LANE,
        tool: toolName,
        ...(auditPath ? { path: auditPath } : {}),
        writeCount: decision.writeCount,
        dispatchCount: decision.dispatchCount,
        budget,
        mode,
        posture,
        messageCode: messageCode(WRITE_BUDGET_DENY_MESSAGE_SLUG)
      },
      env
    );
    const reason = tagMessage(
      WRITE_BUDGET_DENY_MESSAGE_SLUG,
      `${buildAdvisoryLine(decision.writeCount, decision.dispatchCount, env)} The inline write budget is exhausted. Dispatch an Agent or Task before another main-loop write.`
    );
    writeHookText(`${JSON.stringify(denyOutput(reason))}\n`);
    return;
  }

  recordAuditEvent({ at: now, session: sessionId, event: "write", lane: MAIN_LANE, tool: toolName, ...(auditPath ? { path: auditPath } : {}) }, env);
  if (decision.relief) {
    const advisory = claimAdvisory(
      file,
      decision.relief,
      stableAdvisorySignature(
        decision.relief === TAIL_ALLOW_AUDIT_EVENT
          ? [decision.dispatchEpoch, decision.remainingTailSlots]
          : [decision.remainingZeroDispatchWrites, decision.remainingZeroDispatchBytes]
      ),
      now,
      resolveFleetWaveGapMs(env)
    );
    const auditEvent = {
      at: now,
      session: sessionId,
      event: decision.relief,
      lane: MAIN_LANE,
      tool: toolName,
      ...(auditPath ? { path: auditPath } : {}),
      writeCount: decision.writeCount,
      dispatchCount: decision.dispatchCount,
      budget,
      mode,
      posture,
      messageCode: messageCode(
        decision.relief === TAIL_ALLOW_AUDIT_EVENT ? TAIL_ALLOWANCE_ADVISORY_MESSAGE_SLUG : ZERO_DISPATCH_ADVISORY_MESSAGE_SLUG
      )
    };
    if (decision.relief === TAIL_ALLOW_AUDIT_EVENT) {
      auditEvent.remainingTailSlots = decision.remainingTailSlots;
    } else {
      auditEvent.remainingZeroDispatchWrites = decision.remainingZeroDispatchWrites;
      auditEvent.remainingZeroDispatchBytes = decision.remainingZeroDispatchBytes;
    }
    if (advisory.suppressed) {
      auditEvent.suppressed = true;
    }
    recordAuditEvent(auditEvent, env);
    if (!advisory.suppressed) {
      const slug = decision.relief === TAIL_ALLOW_AUDIT_EVENT ? TAIL_ALLOWANCE_ADVISORY_MESSAGE_SLUG : ZERO_DISPATCH_ADVISORY_MESSAGE_SLUG;
      const line = tagMessage(
        slug,
        decision.relief === TAIL_ALLOW_AUDIT_EVENT
          ? buildTailAllowanceAdvisory(decision.remainingTailSlots)
          : buildZeroDispatchAdvisory(decision.remainingZeroDispatchWrites, decision.remainingZeroDispatchBytes)
      );
      writeHookText(`${JSON.stringify(advisoryOutput(line))}\n`);
    }
    return;
  }
  if (decision.candidate) {
    const advisory = claimAdvisory(
      file,
      "write-budget",
      stableAdvisorySignature([decision.candidate.multiple, budget, decision.candidate.dispatchEpoch]),
      now,
      resolveFleetWaveGapMs(env),
      (state) => state.dispatchEpoch === decision.candidate.dispatchEpoch && state.advisedMultiples.includes(decision.candidate.multiple)
    );
    if (!advisory.skipped) {
      const advisorySlug = posture === STRICT_POSTURE ? WRITE_BUDGET_ADVISORY_MESSAGE_SLUG : UNVERIFIED_ADVISORY_MESSAGE_SLUG;
      recordAuditEvent(
        {
          at: now,
          session: sessionId,
          event: "warn",
          lane: MAIN_LANE,
          tool: toolName,
          ...(auditPath ? { path: auditPath } : {}),
          writeCount: decision.writeCount,
          dispatchCount: decision.dispatchCount,
          budget,
          mode,
          posture,
          messageCode: messageCode(advisorySlug),
          ...(advisory.suppressed ? { suppressed: true } : {})
        },
        env
      );
      if (!advisory.suppressed) {
        const line = tagMessage(
          advisorySlug,
          posture === STRICT_POSTURE ? buildAdvisoryLine(decision.writeCount, decision.dispatchCount, env) : buildUnverifiedAdvisory(decision.writeCount, decision.dispatchCount, env)
        );
        writeHookText(`${JSON.stringify(advisoryOutput(line))}\n`);
      }
    }
  }
}

export { handleWrite };
