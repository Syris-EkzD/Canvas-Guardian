import { useCallback } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { View as Box } from 'react-native';
import { demo } from '../../src/api/store.ts';
import { views } from '../../src/api/types.ts';
import { Button, Copy, Screen, ViewContent, labels, styles, useDemo } from '../../src/ui';

export default function Planner() {
  const params=useLocalSearchParams<{view?:string}>();
  const view=views.find(v=>v===params.view)??'today';
  const s=useDemo();
  useFocusEffect(useCallback(()=>{
    const current=demo.getState().views[view];
    if(!current.snapshot&&!current.error)void demo.load(view);
    return ()=>demo.cancel(view);
  },[view,s.scenario]));
  return <Screen><Copy kind="heading">Planner</Copy><Box style={styles.row}>
    {views.map(v=><Button key={v} label={labels[v]} selected={v===view} onPress={()=>router.setParams({view:v})}/>)}
  </Box><Copy kind="small" tone="muted">{view==='saved'?'Saved is a local Guardian status, not Canvas submission or course archive.':view==='week'?'Rolling next 7 days from the fixture evaluation time.':view==='today'?'Manila calendar day, including earlier deadlines.':'Includes overdue and undated pending activities.'}</Copy>
  <ViewContent view={view} state={s.views[view]}/></Screen>;
}
