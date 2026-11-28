import { useCallback } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { demo } from '../../src/api/store.ts';
import { Button, Copy, Screen, StatusContent, ViewContent, useDemo, Notice } from '../../src/ui';

export default function Home() {
  const s=useDemo();
  useFocusEffect(useCallback(()=>{
    const current=demo.getState();
    if(!current.views.today.snapshot&&!current.views.today.error)void demo.load('today');
    if(!current.views.pending.snapshot&&!current.views.pending.error)void demo.load('pending');
    if(!current.status.data&&!current.status.error)void demo.loadStatus();
  },[]));
  return <Screen><Copy kind="heading">Your academic overview</Copy>
    {s.locked?<Notice error={s.locked}/>:<>
      <ViewContent view="today" state={s.views.today} preview/>
      <Button label="Open Today planner" onPress={()=>router.navigate({pathname:'/planner',params:{view:'today'}})}/>
      <ViewContent view="pending" state={s.views.pending} preview/>
      <Button label="Open Pending planner" onPress={()=>router.navigate({pathname:'/planner',params:{view:'pending'}})}/>
      <StatusContent compact/>
    </>}
  </Screen>;
}
