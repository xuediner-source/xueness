import React from "react";
import { t as tr } from "../i18n";

const STATUS_LABELS: Record<string, string> = { created: '待执行', pending: '等待中', queued: '已排队', running: '运行中', pausing: '正在暂停', paused: '已暂停', stopping: '正在取消', cancelled: '已取消', completed: '已完成', failed: '失败', interrupted: '已中断', blocked: '受阻', closed: '已关闭' };
export function OperationStatus({ status }: { status: string }) { return <span className="xn-operation-status" data-status={status}><span aria-hidden="true" />{tr(STATUS_LABELS[status] || status)}</span>; }
export function OperationHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) { return <header className="xn-operation-heading"><span className="xn-operation-heading__icon" aria-hidden="true">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></header>; }
