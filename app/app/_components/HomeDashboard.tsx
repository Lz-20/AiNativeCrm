import Link from "next/link";
import {
  ArrowRight,
  ArrowSquareOut,
  CalendarBlank,
  CheckCircle,
  ClockCountdown,
  CurrencyDollar,
  Robot,
  Users,
} from "@/lib/ui/icons";
import type { HomeDashboardData } from "@/lib/home/types";

function money(cents: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function dateLabel(value: string | null) {
  if (!value) return "无截止日期";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  awaiting_confirmation: "待确认",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

export function HomeDashboard({ data, displayName, workspaceName }: {
  data: HomeDashboardData;
  displayName: string;
  workspaceName: string;
}) {
  const today = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
  const maxStage = Math.max(1, ...data.stages.map((stage) => stage.count));
  const stats = [
    { label: "客户总数", value: data.contactCount.toLocaleString("zh-CN"), detail: "组织内有效联系人", Icon: Users },
    { label: "进行中商机", value: data.activeLeadCount.toLocaleString("zh-CN"), detail: "所有销售漏斗", Icon: ArrowSquareOut },
    { label: "待处理任务", value: data.openTaskCount.toLocaleString("zh-CN"), detail: "尚未完成", Icon: CalendarBlank },
    { label: "在途商机金额", value: money(data.activeLeadValueCents), detail: "按当前开放商机汇总", Icon: CurrencyDollar },
  ];

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6 px-1 py-2 sm:px-2 lg:space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{today} · {workspaceName}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">早上好，{displayName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">今天一起推进客户关系，让 Agent 承担重复的 CRM 操作。</p>
        </div>
        <Link href="/app/ai/workbench" className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[var(--color-accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-500)]">
          <Robot size={17} aria-hidden /> 进入 Agent 工作台 <ArrowRight size={16} aria-hidden />
        </Link>
      </header>

      <section aria-label="业务概览" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, detail, Icon }) => (
          <article key={label} className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{label}</span><Icon size={17} className="text-accent" aria-hidden />
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </article>
        ))}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)]">
        <section className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div><h2 className="font-semibold">最近 Agent 活动</h2><p className="mt-1 text-xs text-muted-foreground">运行过程可在工作台完整回放</p></div>
            <Link href="/app/ai/workbench" className="text-sm text-accent hover:underline">查看工作台 <ArrowRight size={14} className="ml-1 inline" aria-hidden /></Link>
          </div>
          {data.agentRuns.length ? (
            <ul className="divide-y">
              {data.agentRuns.map((run) => (
                <li key={run.id}>
                  <Link href={`/app/ai/workbench?run=${encodeURIComponent(run.id)}`} className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/60">
                    <span className="mt-0.5 rounded-md bg-accent-soft p-2 text-accent"><Robot size={17} aria-hidden /></span>
                    <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-sm font-medium">{run.agentName}<span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">{statusLabels[run.status] ?? run.status}</span></span><span className="mt-1 block truncate text-sm text-muted-foreground">{run.task}</span><span className="mt-1 block text-xs text-text-subtle">{dateLabel(run.createdAt)}</span></span>
                    <ArrowSquareOut size={16} className="mt-1 shrink-0 text-text-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex min-h-44 flex-col items-center justify-center px-5 text-center">
              <span className="rounded-full bg-accent-soft p-3 text-accent"><Robot size={22} aria-hidden /></span>
              <p className="mt-3 text-sm font-medium">还没有 Agent 执行记录</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">选择一个内置 Agent，给它一个真实的 CRM 目标，第一条运行记录会出现在这里。</p>
              <Link href="/app/ai/workbench" className="mt-3 text-sm font-medium text-accent hover:underline">运行第一个任务 <ArrowRight size={14} className="ml-1 inline" aria-hidden /></Link>
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div><h2 className="font-semibold">即将到期任务</h2><p className="mt-1 text-xs text-muted-foreground">按截止时间优先处理 CRM 跟进</p></div>
            <Link href="/app/tasks" className="text-sm text-accent hover:underline">全部任务 <ArrowRight size={14} className="ml-1 inline" aria-hidden /></Link>
          </div>
          {data.tasks.length ? (
            <ul className="divide-y">
              {data.tasks.map((task) => (
                <li key={task.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span className="mt-0.5 text-accent"><ClockCountdown size={17} aria-hidden /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="mt-1 block text-xs text-muted-foreground">{dateLabel(task.dueDate)} · {task.status === "in_progress" ? "进行中" : "待处理"}</span></span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{task.priority === "urgent" ? "紧急" : task.priority === "high" ? "高优先级" : "普通"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex min-h-44 flex-col items-center justify-center px-5 text-center">
              <CheckCircle size={24} className="text-success" aria-hidden />
              <p className="mt-3 text-sm font-medium">当前没有到期任务</p>
              <Link href="/app/tasks" className="mt-2 text-sm text-accent hover:underline">查看任务列表</Link>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div><h2 className="font-semibold">销售漏斗</h2><p className="mt-1 text-xs text-muted-foreground">{data.pipelineName ? `${data.pipelineName} · 当前开放商机` : "开放商机按阶段分布"}</p></div>
          <Link href="/app/kanban" className="text-sm text-accent hover:underline">查看完整漏斗 <ArrowRight size={14} className="ml-1 inline" aria-hidden /></Link>
        </div>
        {data.stages.length ? (
          <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
            {data.stages.map((stage) => (
              <article key={stage.id} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2"><h3 className="truncate text-sm font-medium">{stage.name}</h3><span className="text-sm tabular-nums text-muted-foreground">{stage.count}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(stage.count ? 6 : 0, Math.round((stage.count / maxStage) * 100))}%` }} /></div>
                <p className="mt-2 text-xs text-muted-foreground">{money(stage.valueCents)}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">尚未配置可展示的销售阶段。<Link href="/app/kanban" className="ml-1 text-accent hover:underline">设置销售漏斗</Link></div>
        )}
      </section>
    </div>
  );
}
