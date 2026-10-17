export type HomeTask = {
  id: string;
  title: string;
  dueDate: string | null;
  priority: string;
  status: string;
};

export type HomeAgentRun = {
  id: string;
  agentName: string;
  task: string;
  status: string;
  createdAt: string;
};

export type HomePipelineStage = {
  id: string;
  name: string;
  count: number;
  valueCents: number;
};

export type HomeDashboardData = {
  contactCount: number;
  activeLeadCount: number;
  openTaskCount: number;
  activeLeadValueCents: number;
  tasks: HomeTask[];
  agentRuns: HomeAgentRun[];
  stages: HomePipelineStage[];
  pipelineName: string | null;
};
