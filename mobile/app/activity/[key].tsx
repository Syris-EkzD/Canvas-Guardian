import { useLocalSearchParams } from 'expo-router';
import { views } from '../../src/api/types.ts';
import { Copy, Fresh, Notice, Screen, date, localStatus, useDemo } from '../../src/ui';

export default function ActivitySummary() {
  const params=useLocalSearchParams<{key:string;view:string}>();
  const s=useDemo(), view=views.find(v=>v===params.view);
  const source=view?s.views[view]:undefined;
  const snap=source?.snapshot;
  const item=snap?.data.items.find(a=>a.key===params.key);
  return <Screen>{s.locked?<Notice error={s.locked}/>:item&&snap?<>
    <Copy kind="small" tone="muted">{item.courseName}</Copy><Copy kind="heading">{item.title}</Copy>
    <Copy>Due: {item.dueAt?date(item.dueAt)+' PHT':'None'}</Copy>
    {item.dueAt&&Date.parse(item.dueAt)<Date.parse(snap.data.evaluatedAt)&&item.guardianStatus==='pending'&&<Copy tone="danger">Overdue at fixture evaluation time</Copy>}
    <Copy>{localStatus(item)}</Copy><Copy>Canvas submission: not reported as submitted in this view.</Copy>
    <Copy kind="small" tone="muted">Synthetic destination (not a link)</Copy><Copy>{item.canvasUrl??'No Canvas URL'}</Copy>
    <Fresh snapshot={snap} stale={source?.stale}/>
  </>:<Copy>Activity unavailable in the current authorized demo snapshot. Return to Planner and refresh.</Copy>}</Screen>;
}
