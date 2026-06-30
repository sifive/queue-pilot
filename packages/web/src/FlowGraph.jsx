import React, { useLayoutEffect, useRef, useState } from "react";
import { hierarchy, tree } from "d3";
import { createPortal } from "react-dom";

const NODE_WIDTH = 210;
const NODE_HEIGHT = 94;
const TOOLTIP_OFFSET = 16;
const TOOLTIP_MARGIN = 12;
const STOP_TAGS = new Set([
  "scratch", "nfs", "teams", "share", "builds", "build", "common", "archived", "archived-builds",
  "workspace", "workspaces", "slurm", "slurm_out", "internal", "sifive", "jobs", "monitor",
]);

const titleCase = (value = "") => String(value).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function compactLabels(items = [], limit = 3) {
  const labels = items.filter(Boolean);
  if (labels.length <= limit) return labels.join(", ");
  return `${labels.slice(0, limit).join(", ")} +${labels.length - limit}`;
}

function tokenizeFlow(group) {
  if (group.isControlPlane) return ["control-plane", "slurm", "jenkins"];
  const values = [group.wckey || "", group.workdirRoot || "", group.label || ""];
  const tags = [];
  for (const value of values) {
    const tokens = String(value)
      .split(/[^A-Za-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 || /^\d+$/.test(token));
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (STOP_TAGS.has(normalized)) continue;
      if (tags.some((existing) => existing.toLowerCase() === normalized)) continue;
      tags.push(token);
      if (tags.length >= 6) return tags;
    }
  }
  return tags;
}

function fmtDrainHours(hours = 0) {
  if (!hours) return "clear";
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function queuePressureSummary(queuePressure) {
  if (!queuePressure?.aheadJobs) return "No other-flow queue pressure detected";
  const flowLabel = queuePressure.externalFlows ? ` across ${queuePressure.externalFlows} flow${queuePressure.externalFlows === 1 ? "" : "s"}` : "";
  return `${queuePressure.aheadJobs} higher-priority job${queuePressure.aheadJobs === 1 ? "" : "s"} ahead${flowLabel}`;
}

function queuePressureBadges(queuePressure) {
  if (!queuePressure?.aheadJobs) return ["Queue clear"];
  return [
    `${queuePressure.aheadJobs} ahead`,
    queuePressure.drainHours ? `~${fmtDrainHours(queuePressure.drainHours)} drain` : `${queuePressure.externalFlows || 0} ext flows`,
  ];
}

function summarizeJobs(items = [], limit = 4) {
  return items.slice(0, limit).map((item) => ({
    label: `${item.jobId} ${item.name || ""}`.trim(),
    meta: [
      item.state,
      item.user,
      item.account,
      item.externalQueuePressure?.aheadJobs ? `${item.externalQueuePressure.aheadJobs} ahead` : "",
      item.externalQueuePressure?.drainHours ? `~${fmtDrainHours(item.externalQueuePressure.drainHours)} drain` : "",
    ].filter(Boolean).join(" / "),
  }));
}

function makeNode({ title, subtitle, tone, items = [], badges = [], tags = [], children = [] }) {
  return {
    title,
    subtitle,
    tone,
    items,
    badges,
    tags,
    children: children.filter(Boolean),
  };
}

function reasonNodes(group) {
  const jobsByCategory = new Map();
  for (const item of group.children || group.pendingJobs || []) {
    const key = item.category || "other";
    if (!jobsByCategory.has(key)) jobsByCategory.set(key, []);
    jobsByCategory.get(key).push(item);
  }

  return Object.entries(group.reasonMix || {})
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => makeNode({
      title: titleCase(category),
      subtitle: `${count} blocked job${count === 1 ? "" : "s"}`,
      tone: "blocked",
      badges: [`${count} waiting`],
      items: summarizeJobs(jobsByCategory.get(category) || []),
    }));
}

function buildGraphModel(mode, group) {
  const tags = tokenizeFlow(group);
  const flowRoot = makeNode({
    title: group.label || group.wckey || "Flow",
    subtitle: group.workdirRoot || "WCKey-derived flow",
    tone: "flow",
    badges: [
      mode === "running" ? `${group.runningCount || 0} running` : `${group.pendingCount || group.blockedChildren || 0} blocked`,
      group.runningCount ? `${group.runningCount} active` : null,
      group.maxWaitHours ? `${group.maxWaitHours.toFixed(group.maxWaitHours >= 10 ? 0 : 1)}h max wait` : null,
      group.maxElapsedHours ? `${group.maxElapsedHours.toFixed(group.maxElapsedHours >= 10 ? 0 : 1)}h max runtime` : null,
    ].filter(Boolean),
    tags,
  });

  if (mode === "logjam") {
    const pressure = group.externalQueuePressure;
    const originNode = makeNode({
      title: "Origin Runs",
      subtitle: compactLabels((group.originParents || []).map((item) => item.jobId)),
      tone: "origin",
      badges: [
        `${(group.originParents || []).length} parent run${(group.originParents || []).length === 1 ? "" : "s"}`,
        pressure?.aheadJobs ? `${pressure.aheadJobs} ext ahead` : null,
      ].filter(Boolean),
      items: summarizeJobs(group.originParents || []),
    });
    const queueNode = makeNode({
      title: "External Queue",
      subtitle: queuePressureSummary(pressure),
      tone: "queue",
      badges: queuePressureBadges(pressure),
      items: (pressure?.topFlows || []).map((flow) => ({
        label: flow.label,
        meta: [`${flow.count} ahead`, flow.partition].filter(Boolean).join(" / "),
      })),
    });
    const runningNode = makeNode({
      title: "Active Runners",
      subtitle: pressure?.aheadJobs ? `${compactLabels((group.runningParents || []).map((item) => item.jobId))} · ~${fmtDrainHours(pressure.drainHours)} est drain` : compactLabels((group.runningParents || []).map((item) => item.jobId)),
      tone: "running",
      badges: [`${group.runningCount || 0} running`, pressure?.aheadJobs ? `${pressure.aheadJobs} ahead` : null].filter(Boolean),
      items: summarizeJobs(group.runningParents || []),
      children: [queueNode, ...reasonNodes(group)],
    });
    originNode.children = [runningNode];
    flowRoot.children = [originNode];
    return flowRoot;
  }

  if (mode === "pending") {
    const blockers = group.blockers?.length ? group.blockers : group.originParents || [];
    const blockerNode = makeNode({
      title: "Parent Blockers",
      subtitle: compactLabels(blockers.map((item) => item.jobId)),
      tone: "origin",
      badges: [`${blockers.length} upstream blocker${blockers.length === 1 ? "" : "s"}`],
      items: summarizeJobs(blockers),
    });
    const queueNode = makeNode({
      title: "Pending Group",
      subtitle: `${group.pendingCount || 0} jobs inheriting the same flow tags`,
      tone: "blocked",
      badges: [`${group.pendingCount || 0} waiting`, `${(group.accountLabel || group.userLabel || "").trim()}`.trim()].filter(Boolean),
      items: summarizeJobs(group.pendingJobs || []),
      children: reasonNodes(group),
    });
    blockerNode.children = [queueNode];
    flowRoot.children = [blockerNode];
    return flowRoot;
  }

  if (mode === "control") {
    const controlParents = makeNode({
      title: "Control Roots",
      subtitle: compactLabels((group.originParents || []).map((item) => item.jobId)) || "Scheduler and orchestration roots",
      tone: "origin",
      badges: [`${(group.originParents || []).length} root process${(group.originParents || []).length === 1 ? "" : "es"}`],
      items: summarizeJobs(group.originParents || group.runningJobs || []),
    });
    const controlRunners = makeNode({
      title: "Active Runners",
      subtitle: `${group.runningCount || 0} orchestration runner${group.runningCount === 1 ? "" : "s"}`,
      tone: "running",
      badges: [`${group.runningCount || 0} running`],
      items: summarizeJobs(group.runningJobs || []),
    });
    const blockedQueue = makeNode({
      title: "Blocked Queue",
      subtitle: `${group.pendingCount || 0} downstream job${group.pendingCount === 1 ? "" : "s"} waiting on control-plane activity`,
      tone: "blocked",
      badges: [`${group.pendingCount || 0} blocked`],
      items: summarizeJobs(group.pendingJobs || []),
      children: reasonNodes(group),
    });
    flowRoot.children = [controlParents, controlRunners, blockedQueue].filter((node) => node.items.length || node.children.length || node.badges[0] !== "0 blocked");
    return flowRoot;
  }

  const originNode = makeNode({
    title: "Origin Parents",
    subtitle: compactLabels((group.originParents || []).map((item) => item.jobId)),
    tone: "origin",
    badges: [`${(group.originParents || []).length} traced parent${(group.originParents || []).length === 1 ? "" : "s"}`],
    items: summarizeJobs(group.originParents || []),
  });
  const runningNode = makeNode({
    title: "Running Group",
    subtitle: `${group.runningCount || 0} active jobs under one flow tag set`,
    tone: "running",
    badges: [`${group.runningCount || 0} running`, group.userLabel || null].filter(Boolean),
    items: summarizeJobs(group.runningJobs || []),
  });
  originNode.children = [runningNode];
  flowRoot.children = [originNode];
  return flowRoot;
}

function layoutGraph(model) {
  const root = hierarchy(model);
  tree().nodeSize([NODE_HEIGHT + 24, NODE_WIDTH + 52])(root);
  const nodes = root.descendants();
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const maxY = Math.max(...nodes.map((node) => node.y));
  return {
    root,
    nodes,
    links: root.links(),
    width: maxY + NODE_WIDTH + 112,
    height: maxX - minX + NODE_HEIGHT + 112,
    offsetX: 36,
    offsetY: 56 - minX,
  };
}

function linkPath(source, target) {
  const sx = source.y + NODE_WIDTH;
  const sy = source.x + NODE_HEIGHT / 2;
  const tx = target.y;
  const ty = target.x + NODE_HEIGHT / 2;
  const cx = (sx + tx) / 2;
  return `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function FlowGraph({ mode, group }) {
  const [tooltip, setTooltip] = useState(null);
  const [tooltipFrame, setTooltipFrame] = useState({ left: 0, top: 0, placement: "below" });
  const tooltipRef = useRef(null);
  const graph = layoutGraph(buildGraphModel(mode, group));

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current || typeof window === "undefined") return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const maxLeft = Math.max(TOOLTIP_MARGIN, window.innerWidth - rect.width - TOOLTIP_MARGIN);
    const left = clamp(tooltip.x + TOOLTIP_OFFSET, TOOLTIP_MARGIN, maxLeft);
    const fitsBelow = tooltip.y + TOOLTIP_OFFSET + rect.height + TOOLTIP_MARGIN <= window.innerHeight;
    const top = fitsBelow
      ? tooltip.y + TOOLTIP_OFFSET
      : Math.max(TOOLTIP_MARGIN, tooltip.y - rect.height - TOOLTIP_OFFSET);
    const placement = fitsBelow ? "below" : "above";
    setTooltipFrame((current) => (
      current.left === left && current.top === top && current.placement === placement
        ? current
        : { left, top, placement }
    ));
  }, [tooltip]);

  return (
    <div className="flow-tree-shell">
      <svg className="flow-tree-svg" viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="xMinYMin meet">
        <g transform={`translate(${graph.offsetX}, ${graph.offsetY})`}>
          {graph.links.map((link) => (
            <path key={`${link.source.data.title}-${link.target.data.title}`} className="flow-tree-link" d={linkPath(link.source, link.target)} />
          ))}
          {graph.nodes.map((node) => (
            <g key={`${node.depth}-${node.data.title}-${node.x}-${node.y}`} transform={`translate(${node.y}, ${node.x})`}>
              <foreignObject width={NODE_WIDTH} height={NODE_HEIGHT}>
                <div
                  className={`flow-tree-node tone-${node.data.tone}`}
                  onMouseEnter={(event) => setTooltip({ node: node.data, x: event.clientX, y: event.clientY })}
                  onMouseMove={(event) => setTooltip((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current))}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <div className="flow-tree-node-title">{node.data.title}</div>
                  <div className="flow-tree-node-subtitle">{node.data.subtitle}</div>
                  {node.data.badges?.length ? (
                    <div className="flow-tree-badges">
                      {node.data.badges.slice(0, 2).map((badge) => <span key={badge} className="flow-tree-badge">{badge}</span>)}
                    </div>
                  ) : null}
                  {node.data.tags?.length ? (
                    <div className="flow-tree-tags">
                      {node.data.tags.slice(0, 4).map((tag) => <span key={tag} className="flow-tree-tag">{tag}</span>)}
                    </div>
                  ) : null}
                </div>
              </foreignObject>
            </g>
          ))}
        </g>
      </svg>
      {tooltip && typeof document !== "undefined" ? createPortal(
        <div
          ref={tooltipRef}
          className="flow-tree-tooltip"
          data-placement={tooltipFrame.placement}
          style={{ left: tooltipFrame.left, top: tooltipFrame.top }}
        >
          <strong>{tooltip.node.title}</strong>
          <div className="flow-tree-tooltip-subtitle">{tooltip.node.subtitle}</div>
          {tooltip.node.tags?.length ? (
            <div className="flow-tree-tooltip-tags">
              {tooltip.node.tags.map((tag) => <span key={tag} className="flow-tree-tag">{tag}</span>)}
            </div>
          ) : null}
          {tooltip.node.items?.length ? (
            <div className="flow-tree-tooltip-items">
              {tooltip.node.items.map((item) => (
                <div key={`${item.label}-${item.meta}`} className="flow-tree-tooltip-item">
                  <div>{item.label}</div>
                  {item.meta ? <small>{item.meta}</small> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="flow-tree-tooltip-subtitle">Hover cells are grouped. This node is intentionally collapsed.</div>
          )}
        </div>,
        document.body
      ) : null}
    </div>
  );
}
