import { useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View as Box, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { demo, type Snapshot, type ViewState } from './api/store.ts';
import type { Activity, View } from './api/types.ts';
import type { DemoError } from './api/validate.ts';

export const labels: Record<View,string> = {today:'Today',week:'Next 7 days',pending:'Pending',saved:'Saved'};
export const useDemo = () => useSyncExternalStore(demo.subscribe,demo.getState,demo.getState);
export function usePalette() {
  return useColorScheme()==='dark'
    ? {bg:'#111817',surface:'#1D2927',text:'#EFF7F5',muted:'#B7CCC7',accent:'#83E0CC',line:'#526762',danger:'#FFB4A9'}
    : {bg:'#F3F7F6',surface:'#FFFFFF',text:'#152D29',muted:'#415C56',accent:'#00695C',line:'#A8BDB7',danger:'#9C2519'};
}
export const styles = StyleSheet.create({
  screen:{padding:16,gap:12,paddingBottom:32}, heading:{fontSize:24,fontWeight:'700'},
  title:{fontSize:18,fontWeight:'700'}, body:{fontSize:16}, small:{fontSize:14},
  button:{minHeight:48,minWidth:48,justifyContent:'center',paddingHorizontal:12,paddingVertical:10,borderRadius:10,borderWidth:1},
  card:{padding:14,borderRadius:12,borderWidth:1,gap:6}, row:{flexDirection:'row',flexWrap:'wrap',gap:8},
});
export function Copy({children,kind='body',tone='text'}:{children:ReactNode;kind?:'heading'|'title'|'body'|'small';tone?:'text'|'muted'|'accent'|'danger'}) {
  const p=usePalette(); return <Text accessibilityRole={kind==='heading'?'header':undefined} style={[styles[kind],{color:p[tone]}]}>{children}</Text>;
}
export function Screen({children}:{children:ReactNode}) {
  const p=usePalette();return <ScrollView style={{backgroundColor:p.bg,flex:1}} contentContainerStyle={styles.screen}>
    <Copy kind="small" tone="accent">DEMO · Synthetic academic data · No live connection</Copy>{children}
  </ScrollView>;
}
export function Card({children}:{children:ReactNode}) {
  const p=usePalette();return <Box style={[styles.card,{backgroundColor:p.surface,borderColor:p.line}]}>{children}</Box>;
}
export function Button({label,onPress,disabled=false,selected}:{label:string;onPress:()=>void;disabled?:boolean;selected?:boolean}) {
  const p=usePalette();return <Pressable accessibilityRole="button" accessibilityState={{disabled,selected}} disabled={disabled} onPress={onPress}
    style={({pressed})=>[styles.button,{backgroundColor:p.surface,borderColor:selected?p.accent:p.line,opacity:disabled?.55:pressed?.75:1}]}>
    <Text style={[styles.body,{color:p.accent,fontWeight:selected?'700':'500'}]}>{label}{selected?' · Selected':''}</Text>
  </Pressable>;
}
export const date = (value: string) => new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
export const localStatus = (a: Activity) => a.guardianStatus==='completed_offline'?'Completed offline (Guardian)':a.guardianStatus==='dismissed'?'Dismissed (Guardian)':'Pending (Guardian)';
export function Fresh({snapshot,stale=false}:{snapshot:Snapshot;stale?:boolean}) {
  const d=snapshot.data;return <Card>
    {stale&&<Copy tone="danger">Stale — previous complete demo snapshot</Copy>}
    <Copy kind="small" tone="muted">Fixture source: Canvas · {d.freshness.state} at server · {date(d.freshness.fetchedAt)} PHT</Copy>
    <Copy kind="small" tone="muted">Evaluated {date(d.evaluatedAt)} PHT · Retrieved locally {date(new Date(snapshot.retrievedAt).toISOString())} PHT</Copy>
  </Card>;
}
export function Notice({error}:{error:DemoError}) {
  const message: Record<string,string> = {UNAUTHENTICATED:'Demo authorization expired. Reset demo to unlock.',FORBIDDEN:'Demo access denied. Reset demo to unlock.',ACCOUNT_UNVERIFIED:'Account not verified. Data hidden until demo reset.',ACCOUNT_MISMATCH:'Account mismatch. Data hidden until demo reset.',RATE_LIMITED:'Request limit reached. Wait before retrying.',VIEW_CHANGED:'View changed again. Retry from the first page.',OFFLINE:'Fixture transport unavailable.',PROTOCOL:'Invalid fixture response. No new data accepted.'};
  return <Box accessibilityLiveRegion="polite"><Copy tone="danger">{message[error.code]??'Demo service unavailable. Retry when ready.'}</Copy>{error.requestId&&<Copy kind="small">Request ID: {error.requestId}</Copy>}</Box>;
}
export function ActivityRow({activity,view,evaluatedAt}:{activity:Activity;view:View;evaluatedAt:string}) {
  const p=usePalette(); const overdue=activity.dueAt!==null&&Date.parse(activity.dueAt)<Date.parse(evaluatedAt)&&activity.guardianStatus==='pending';
  return <Pressable accessibilityRole="button" accessibilityLabel={activity.title+', '+activity.courseName+', '+(activity.dueAt?date(activity.dueAt)+' PHT':'No deadline')+', '+localStatus(activity)+(overdue?', overdue':'')} onPress={()=>router.push({pathname:'/activity/[key]',params:{key:activity.key,view}})}
    style={({pressed})=>[styles.card,{minHeight:48,backgroundColor:p.surface,borderColor:p.line,opacity:pressed?.75:1}]}>
    <Copy kind="small" tone="muted">{activity.courseName}</Copy><Copy kind="title">{activity.title}</Copy>
    <Copy tone={overdue?'danger':'text'}>{activity.dueAt?date(activity.dueAt)+' PHT':'No deadline'}{overdue?' · Overdue':''}</Copy><Copy kind="small" tone="muted">{localStatus(activity)}</Copy>
  </Pressable>;
}
export function ViewContent({view,state,preview=false}:{view:View;state:ViewState;preview?:boolean}) {
  const all=useDemo(), snap=state.snapshot, p=usePalette();
  if(all.locked)return <Notice error={all.locked}/>;
  return <>
    {state.busy&&<Box accessibilityLiveRegion="polite" style={styles.row}><ActivityIndicator color={p.accent}/><Copy>Loading demo data…</Copy></Box>}
    {state.error&&<Notice error={state.error}/>}
    {!snap&&!state.busy&&<Copy tone="muted">No saved demo snapshot available.</Copy>}
    {snap&&<>
      <Fresh snapshot={snap} stale={state.stale}/>
      <Copy kind="title">{labels[view]} · {snap.data.page.total}{state.stale?' (previous total)':''}</Copy>
      {snap.data.page.total===0?<Copy>{state.stale?'Previous snapshot was empty.':'No activities in this view.'}</Copy>:null}
      {snap.data.page.nextOffset!==null&&<Copy kind="small" tone="muted">Loaded {snap.data.items.length} of {snap.data.page.total}</Copy>}
      {(preview?snap.data.items.slice(0,2):snap.data.items).map(a=><ActivityRow key={a.key} activity={a} view={view} evaluatedAt={snap.data.evaluatedAt}/>)}
      {!preview&&snap.data.page.nextOffset!==null&&!state.stale&&!state.error&&<Button label="Load more" disabled={state.busy||all.retryUntil>0} onPress={()=>{void demo.load(view,true);}}/>}
    </>}
    <Button label={state.error?'Retry':'Refresh demo view'} disabled={state.busy||all.retryUntil>0} onPress={()=>{void demo.load(view);}}/>
    {all.retryUntil>0&&<Copy kind="small" tone="muted">Retry temporarily disabled (rate limit).</Copy>}
  </>;
}
export function StatusContent({compact=false}:{compact?:boolean}) {
  const state=useDemo(), s=state.status;
  if(state.locked)return <Notice error={state.locked}/>;
  return <Card><Copy kind="title">Configured status</Copy>
    {s.busy&&<Copy>Loading status…</Copy>}
    {s.error&&<Notice error={s.error}/>}
    {s.data?<><Copy>{s.stale?'Previous demo configuration (stale) · ':''}Monitoring: {s.data.monitoring}</Copy>
      <Copy>Calendar sync configured: {s.data.calendarSyncEnabled?'enabled':'disabled'}</Copy>
      <Copy>Runtime health: unverified</Copy>{!compact&&<><Copy>Configured schedule: {s.data.scheduleConfiguredMinutes} minutes</Copy><Copy>Time zone: {s.data.timezone}</Copy><Copy kind="small">Account: synthetic fixture only</Copy></>}
    </>:!s.busy&&<Copy tone="muted">No status available.</Copy>}
    <Button label="Refresh demo status" disabled={s.busy||state.retryUntil>0} onPress={()=>{void demo.loadStatus();}}/>
  </Card>;
}
