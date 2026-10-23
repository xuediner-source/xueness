import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  XuenessTaskList,
  TASK_GROUP_DRAG_MIME,
  eligibleProjectSessionIds,
  dialogFocusWrapIndex,
  isTaskContextMenuShortcut,
  mergeProjectBuckets,
  mergePurposeBuckets,
  mergeWorkspaceBuckets,
  nextSidebarMenuIndex,
  normalizeHiddenProjectRoots,
  persistTaskGroupDrop,
  projectArchivePlan,
  resolveSidebarDragSession,
  restoreSidebarFocus,
  sameSidebarProjectPath,
  shouldDismissGroupEditorOnEscape,
  toggleHiddenProjectRoot,
  toggleSidebarBuckets,
} from './XuenessTaskList';
import {
  createSidebarProjectSection,
  isSidebarProjectPinned,
  moveSidebarProjectToSection,
  normalizeSidebarProjectSections,
  setSidebarProjectLabel,
  sidebarProjectLabel,
  sidebarProjectSectionId,
  togglePinnedProjectRoot,
} from './projectSidebar';
import type { SidebarPreferences, TaskGroup } from './XuenessTaskList';
import { mergeSessionsIndex } from './sessionsIndex';
import type { SessionSummary } from '../../xuenessWorkbench';

const groupFixtures:TaskGroup[]=[
  {id:'one',label:'One',taskIds:['task-a','task-b']},
  {id:'two',label:'Two',taskIds:['task-c']},
];

test('Sidebar native li drag resolves its navigation button and keeps the actual session scope',()=>{
  const sessions:SessionSummary[]=[{id:'task-a',task:'Task A',status:'completed',root:'/workspace/a'}];
  const button={dataset:{sessionId:'task-a'}};
  const row={querySelector(selector:string){assert.equal(selector,'[data-sidebar-navigate="true"][data-session-id]');return button;}};
  const nativeTarget={closest(selector:string){
    if(selector==='[data-session-id]')return null;
    assert.equal(selector,'li.xn-shell-nav__item[draggable="true"]');return row;
  }} as unknown as Pick<Element,'closest'>;
  assert.equal(resolveSidebarDragSession(nativeTarget,sessions),sessions[0]);
  for(const label of ['navigation button','nested label or icon']){
    const target={closest(selector:string){assert.equal(selector,'[data-session-id]');return button;}} as unknown as Pick<Element,'closest'>;
    assert.equal(resolveSidebarDragSession(target,sessions),sessions[0],label);
  }
});

test('Sidebar drag refuses unknown rows and unrelated draggable elements',()=>{
  const sessions:SessionSummary[]=[{id:'task-a',task:'Task A',status:'completed',root:'/workspace/a'}];
  const unknown={closest(){return {dataset:{sessionId:'foreign-task'}};}} as unknown as Pick<Element,'closest'>;
  const empty={closest(){return null;}} as unknown as Pick<Element,'closest'>;
  const unrelated={closest(selector:string){return selector==='[data-session-id]'?null:{querySelector(){return null;}};}} as unknown as Pick<Element,'closest'>;
  assert.equal(resolveSidebarDragSession(unknown,sessions),null);
  assert.equal(resolveSidebarDragSession(empty,sessions),null);
  assert.equal(resolveSidebarDragSession(unrelated,sessions),null);
  assert.equal(resolveSidebarDragSession(null,sessions),null);
  const stale={closest(){return {dataset:{sessionId:'task-a'}};}} as unknown as Pick<Element,'closest'>;
  assert.equal(resolveSidebarDragSession(stale,[]),null,'an ID removed from the current catalog cannot be dragged');
});

test('TaskList gates cached remote configuration summaries independently of files and preserves local rows', () => {
  const sessions: SessionSummary[] = [
    { id: 'remote', task: 'Remote task', status: 'running', sidecar: {
      remote: { connectionId: 'lab', configuration: 'changed', connectionState: 'unknown' },
    } },
    { id: 'local', task: 'Local task', status: 'completed' },
  ];
  const props = { sessions, activeId: null, busy: false, onPreferences: () => {}, onSelect: () => {},
    onRename: () => {}, onArchive: () => {}, onPin: () => {}, onOpenArchived: () => {} };
  for (const view of ['projects', 'workspace', 'purpose', 'timeline'] as const) {
    const enabled = renderToStaticMarkup(<XuenessTaskList {...props} remoteEnabled preferences={{ view }} />);
    assert.match(enabled, /data-remote-summary="changed"/);
    assert.match(enabled, /远程配置已变更/);
    assert.match(enabled, /连接状态未知/);
    assert.match(enabled, /xn-sidebar-item-local/);
    const disabled = renderToStaticMarkup(<XuenessTaskList {...props} remoteEnabled={false} changesEnabled preferences={{ view }} />);
    assert.doesNotMatch(disabled, /data-remote-summary|远程配置已变更/);
    assert.match(disabled, /xn-sidebar-item-remote/);
  }
});

test('TaskList shows a recorded remote phase only while remote is effective', () => {
  const sessions: SessionSummary[] = [
    { id: 'remote', task: 'Remote task', status: 'completed', sidecar: {
      remote: { connectionId: 'lab', configuration: 'configured', connectionState: 'reconnecting' },
    } },
  ];
  const props = { sessions, activeId: null, busy: false, onPreferences: () => {}, onSelect: () => {},
    onRename: () => {}, onArchive: () => {}, onPin: () => {}, onOpenArchived: () => {} };
  const enabled = renderToStaticMarkup(<XuenessTaskList {...props} remoteEnabled />);
  assert.match(enabled, /data-connection-state="reconnecting"/);
  assert.match(enabled, /data-remote-summary="configured"/);
  assert.doesNotMatch(enabled, /连接状态未知/);
  const disabled = renderToStaticMarkup(<XuenessTaskList {...props} remoteEnabled={false} />);
  assert.doesNotMatch(disabled, /data-connection-state|data-remote-summary|正在重连/);
});

test('Compact task list keeps pinned/projects/recent hierarchy, bounded recents and unique row/menu hooks',()=>{
  const sessions = Array.from({length:12},(_,index)=>({id:`recent-${index}`,task:`Task ${index}`,status:'completed',root:'/work/project',updatedAt:new Date(1700000000000+index*1000).toISOString()}));
  sessions.push({id:'pinned',task:'Pinned task',status:'completed',root:'/work/project',updatedAt:new Date(1700000000000).toISOString(),pinned:true} as typeof sessions[number] & {pinned:true});
  const html=renderToStaticMarkup(<XuenessTaskList compact sessions={sessions} activeId="recent-11" busy={false}
    onPreferences={()=>undefined} onSelect={()=>undefined} onRename={()=>undefined} onArchive={()=>undefined} onPin={()=>undefined} onOpenArchived={()=>undefined} />);
  assert.ok(html.indexOf('xn-sidebar-item-pinned')<html.indexOf('xn-task-list__toolbar'));
  assert.ok(html.indexOf('data-project-root')<html.indexOf('xn-task-list__recent'));
  assert.equal((html.match(/data-testid="xn-sidebar-recent-item-/gu)??[]).length,8);
  assert.ok(html.indexOf('xn-sidebar-recent-item-recent-11')<html.indexOf('xn-sidebar-recent-item-recent-10'));
  assert.doesNotMatch(html,/xn-shell-nav__time|xn-sidebar-rename-|xn-sidebar-delete-/u);
  const hooks=[...html.matchAll(/data-testid="(xn-sidebar-(?:recent-)?(?:item|menu)-[^"]+)"/gu)].map(match=>match[1]);
  assert.equal(new Set(hooks).size,hooks.length);
});

test('Sidebar task context menu opens from ContextMenu and Shift+F10 only',()=>{
  assert.equal(isTaskContextMenuShortcut('ContextMenu'),true);
  assert.equal(isTaskContextMenuShortcut('F10',true),true);
  assert.equal(isTaskContextMenuShortcut('F10'),false);
  assert.equal(isTaskContextMenuShortcut('Escape',true),false);
});

test('Sidebar menus wrap arrows and Home/End; dialog traps Tab at its boundaries',()=>{
  assert.equal(nextSidebarMenuIndex(-1,3,'ArrowDown'),0);
  assert.equal(nextSidebarMenuIndex(-1,3,'ArrowUp'),2);
  assert.equal(nextSidebarMenuIndex(2,3,'ArrowDown'),0);
  assert.equal(nextSidebarMenuIndex(0,3,'ArrowUp'),2);
  assert.equal(nextSidebarMenuIndex(1,3,'Home'),0);
  assert.equal(nextSidebarMenuIndex(1,3,'End'),2);
  assert.equal(nextSidebarMenuIndex(1,3,'Enter'),null);
  assert.equal(dialogFocusWrapIndex(0,3,true),2);
  assert.equal(dialogFocusWrapIndex(2,3,false),0);
  assert.equal(dialogFocusWrapIndex(-1,3,false),0);
  assert.equal(dialogFocusWrapIndex(1,3,false),null);
});

test('Sidebar dialogs restore focus to their opener, with a fallback when it was removed',()=>{
  let openerFocus=0;
  let fallbackFocus=0;
  const opener={isConnected:true,focus(){openerFocus++;}};
  const fallback={isConnected:true,focus(){fallbackFocus++;}};
  restoreSidebarFocus(opener,fallback);
  assert.equal(openerFocus,1);
  assert.equal(fallbackFocus,0);
  restoreSidebarFocus({...opener,isConnected:false},fallback);
  assert.equal(openerFocus,1);
  assert.equal(fallbackFocus,1);
});

test('Sidebar group dialog dismisses on ordinary Escape and preserves IME Escape',()=>{
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape'}),true);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape',isComposing:true}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape',nativeEvent:{isComposing:true}}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape',keyCode:229}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape',nativeEvent:{keyCode:229}}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Process'}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Dead'}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Escape',compositionActive:true}),false);
  assert.equal(shouldDismissGroupEditorOnEscape({key:'Enter'}),false);
});

test('Sidebar group drop persists the actual dragged task assignment',()=>{
  let prevented=false;
  let saved:TaskGroup[]|undefined;
  const event={
    preventDefault(){prevented=true;},
    dataTransfer:{getData(type:string){assert.equal(type,TASK_GROUP_DRAG_MIME);return 'task-b';}},
  };
  const moved=persistTaskGroupDrop({
    event,
    targetGroupId:'two',
    targetIsProject:false,
    taskIds:['task-a','task-b','task-c'],
    groups:groupFixtures,
    onPersist(next){saved=next;},
  });
  assert.equal(moved,true);
  assert.equal(prevented,true);
  assert.deepEqual(saved?.map(group=>group.taskIds),[['task-a'],['task-c','task-b']]);

  let ungrouped:TaskGroup[]|undefined;
  assert.equal(persistTaskGroupDrop({
    event,
    targetGroupId:'__ungrouped__',
    targetIsProject:false,
    taskIds:['task-a','task-b','task-c'],
    groups:saved!,
    onPersist(next){ungrouped=next;},
  }),true);
  assert.deepEqual(ungrouped?.map(group=>group.taskIds),[['task-a'],['task-c']]);
});

test('Sidebar group drop ignores invalid tasks and project buckets',()=>{
  let persisted=false;
  let prevented=false;
  const event={preventDefault(){prevented=true;},dataTransfer:{getData:()=> 'foreign-task'}};
  assert.equal(persistTaskGroupDrop({event,targetGroupId:'one',targetIsProject:false,taskIds:['task-a'],groups:groupFixtures,onPersist:()=>{persisted=true;}}),false);
  assert.equal(prevented,true);
  assert.equal(persisted,false);
  prevented=false;
  assert.equal(persistTaskGroupDrop({event,targetGroupId:'project',targetIsProject:true,taskIds:['foreign-task'],groups:groupFixtures,onPersist:()=>{persisted=true;}}),false);
  assert.equal(prevented,false);
  assert.equal(persisted,false);
});

test('TaskList: project labels use workspace name and grouped lists expose edit controls',()=>{
  const base={
    sessions:[
      {id:'task-a',task:'task-a',title:'First task',status:'completed',root:'/work/project-a'},
      {id:'task-b',task:'task-b',title:'Pinned task',status:'running',root:'/work/project-a',pinned:true},
    ],
    activeId:'task-a',
    busy:false,
    onPreferences:(_value:SidebarPreferences)=>{},
    onSelect:(_id:string)=>{},
    onRename:(_id:string)=>{},
    onArchive:(_id:string)=>{},
    onPin:(_id:string,_pinned:boolean)=>{},
    onOpenArchived:()=>{},
  };
  const projects=renderToStaticMarkup(<XuenessTaskList {...base}/>);
  assert.match(projects,/project-a/);
  assert.match(projects,/已置顶/);
  assert.doesNotMatch(projects,/aria-label="添加项目"/);
  assert.doesNotMatch(projects,/data-testid="xn-task-project-new-task"/);
  const groups=renderToStaticMarkup(<XuenessTaskList {...base} preferences={{view:'groups',groups:groupFixtures}}/>);
  assert.match(groups,/One/);
  assert.match(groups,/Two/);
  assert.match(groups,/新建分组/);
  assert.match(groups,/aria-label="重命名"/);
});

test('TaskList: registered and session roots merge, including projects with no sessions',()=>{
  const sessions=[
    {id:'task-a',task:'task-a',title:'First task',status:'completed',root:'/work/project-a'},
    {id:'task-b',task:'task-b',title:'Unregistered root task',status:'running',root:'/work/unregistered'},
  ];
  const buckets=mergeProjectBuckets(sessions,[
    {path:'/work/project-a',name:'Project Alpha'},
    {path:'/work/empty-project',name:'Empty Project'},
  ]);
  assert.deepEqual(buckets.map(bucket=>({id:bucket.id,label:bucket.label,items:bucket.items.map(item=>item.id)})),[
    {id:'/work/project-a',label:'Project Alpha',items:['task-a']},
    {id:'/work/empty-project',label:'Empty Project',items:[]},
    {id:'/work/unregistered',label:'unregistered',items:['task-b']},
  ]);

  const base={
    sessions,
    activeId:'task-a',
    busy:false,
    onPreferences:(_value:SidebarPreferences)=>{},
    onSelect:(_id:string)=>{},
    onRename:(_id:string)=>{},
    onArchive:(_id:string)=>{},
    onPin:(_id:string,_pinned:boolean)=>{},
    onOpenArchived:()=>{},
  };
  const html=renderToStaticMarkup(<XuenessTaskList
    {...base}
    projectRoots={[
      {path:'/work/project-a',name:'Project Alpha'},
      {path:'/work/empty-project',name:'Empty Project'},
    ]}
    onAddProject={(_trigger)=>{}}
    onStartProject={(_root)=>{}}
  />);
  assert.match(html,/aria-label="添加项目"/);
  assert.match(html,/data-project-root="\/work\/project-a"/);
  assert.match(html,/aria-label="新建任务: Project Alpha"/);
  assert.match(html,/data-project-root="\/work\/empty-project"[\s\S]*?data-testid="xn-task-empty-project-new-task"/);
  assert.match(html,/<button[^>]*data-testid="xn-task-empty-project-new-task"[^>]*>[\s\S]*?新建任务<\/button>/);
  assert.equal((html.match(/data-testid="xn-task-project-new-task"/g)??[]).length,3);
  assert.equal((html.match(/data-testid="xn-task-empty-project-new-task"/g)??[]).length,1);
});

test('hidden project roots normalize duplicates and use the workspace picker Windows path rules',()=>{
  const roots=normalizeHiddenProjectRoots([
    '/work/project/', '/work/project', 'C:\\Work\\Project', 'c:/work/project/', '', '../unsafe', null, 7,
  ]);
  assert.deepEqual(roots, ['/work/project/', 'C:\\Work\\Project']);
  assert.equal(sameSidebarProjectPath('C:\\Work\\Project', 'c:/work/project/'), true);
  assert.equal(sameSidebarProjectPath('/Work/Project', '/work/project'), false);
  assert.deepEqual(toggleHiddenProjectRoot(roots, 'c:/WORK/project'), ['/work/project/']);
  assert.deepEqual(toggleHiddenProjectRoot(roots, 'D:\\Work\\Other'), [...roots, 'D:\\Work\\Other']);
});

test('project buckets merge equivalent Windows roots and hide removed project sessions only in that grouping',()=>{
  const sessions:SessionSummary[]=[
    {id:'project-task',task:'Project task',status:'completed',root:'C:\\Work\\Project'},
    {id:'other-task',task:'Other task',status:'completed',root:'C:\\Work\\Other'},
  ];
  const roots=[{path:'c:/work/project/',name:'Project'}, {path:'C:\\Work\\Empty',name:'Empty'}];
  const visible=mergeProjectBuckets(sessions,roots);
  assert.deepEqual(visible.map(bucket=>({id:bucket.id,label:bucket.label,ids:bucket.items.map(item=>item.id)})),[
    {id:'c:/work/project/',label:'Project',ids:['project-task']},
    {id:'C:\\Work\\Empty',label:'Empty',ids:[]},
    {id:'C:\\Work\\Other',label:'Other',ids:['other-task']},
  ]);
  const hidden=mergeProjectBuckets(sessions,roots,['C:/WORK/PROJECT']);
  assert.deepEqual(hidden.map(bucket=>({id:bucket.id,ids:bucket.items.map(item=>item.id)})),[
    {id:'C:\\Work\\Empty',ids:[]},
    {id:'C:\\Work\\Other',ids:['other-task']},
  ]);
  assert.equal(sessions.length,2,'removing a project from the sidebar does not delete its sessions');
});

test('project sidebar pin, display label and section assignments normalize and persist in preferences',()=>{
  const project='C:\\Work\\Sample';
  const pinned=togglePinnedProjectRoot([],project);
  assert.deepEqual(pinned,[project]);
  assert.equal(isSidebarProjectPinned(pinned,'c:/work/sample/'),true);
  assert.deepEqual(togglePinnedProjectRoot(pinned,'c:/WORK/sample'),[]);

  const labels=setSidebarProjectLabel([],project,'  My project  ');
  assert.equal(sidebarProjectLabel(labels,'c:/work/sample/'),'My project');
  assert.deepEqual(setSidebarProjectLabel(labels,project,''),[],'blank label restores the folder name');

  const sections=createSidebarProjectSection([],project,'Research','research');
  assert.equal(sidebarProjectSectionId(sections,'c:/work/sample/'),'research');
  assert.deepEqual(moveSidebarProjectToSection(sections,project,null),[{id:'research',label:'Research',roots:[]}]);
  assert.deepEqual(normalizeSidebarProjectSections([
    ...sections,
    {id:'second',label:'Second',roots:['c:/work/sample/']},
  ]),[
    {id:'research',label:'Research',roots:[project]},
    {id:'second',label:'Second',roots:[]},
  ],'one canonical project root belongs to at most one section while empty sections remain available');

  const buckets=mergeProjectBuckets([], [{path:project,name:'Sample'}], [], labels, pinned, sections);
  assert.deepEqual(buckets.map(({id,label,pinned:isPinned,sectionId})=>({id,label,pinned:isPinned,sectionId})),[
    {id:project,label:'My project',pinned:true,sectionId:'research'},
  ]);
});

test('project archive plan includes pinned chats and skips active/queued chats across equivalent Windows roots',()=>{
  const sessions=[
    {id:'done',task:'Done',status:'completed',root:'C:\\Work\\Sample'},
    {id:'pinned',task:'Pinned',status:'completed',root:'c:/work/sample/',pinned:true},
    {id:'running',task:'Running',status:'running',root:'C:\\Work\\Sample'},
    {id:'queued',task:'Queued',status:'queued',root:'C:\\Work\\Sample'},
    {id:'streaming',task:'Streaming',status:'completed',root:'C:\\Work\\Sample',streaming:{status:'streaming'}},
    {id:'other-project',task:'Other',status:'completed',root:'C:\\Work\\Other'},
  ] as unknown as SessionSummary[];
  const plan=projectArchivePlan(sessions,'c:/WORK/sample');
  assert.deepEqual(plan,{sessionIds:['done','pinned'],skippedActiveCount:3});
  assert.deepEqual(eligibleProjectSessionIds(sessions,'C:\\Work\\Sample'),['done','pinned']);
});

test('project view renders pinned chats once in the pinned list and keeps the project bucket unpinned',()=>{
  const sessions:SessionSummary[]=[
    {id:'pinned-chat',task:'Pinned chat',status:'completed',root:'/work/sample',pinned:true},
    {id:'regular-chat',task:'Regular chat',status:'completed',root:'/work/sample'},
  ];
  const html=renderToStaticMarkup(<XuenessTaskList sessions={sessions} activeId={null} busy={false}
    preferences={{view:'projects'}} projectRoots={[{path:'/work/sample',name:'Sample'}]}
    onPreferences={()=>undefined} onSelect={()=>undefined} onRename={()=>undefined} onArchive={()=>undefined}
    onPin={()=>undefined} onOpenArchived={()=>undefined} />);
  assert.equal((html.match(/data-session-id="pinned-chat"/g)??[]).length,1);
  assert.equal((html.match(/data-session-id="regular-chat"/g)??[]).length,1);
});

test('TaskList: workspace and purpose views group sessions-index sidecars with a fallback bucket',()=>{
  const sessions = [
    { id:'one', task:'one', title:'One', status:'completed', root:'/legacy/a', sidecar:{ workspacePath:'/work/alpha', workspaceName:'Alpha', purpose:'project' } },
    { id:'two', task:'two', title:'Two', status:'running', root:'/legacy/b', workspace:'/work/alpha', purpose:'conversation' },
    { id:'three', task:'three', title:'Three', status:'completed', root:'/legacy/c' },
  ] as unknown as import('../../xuenessWorkbench').SessionSummary[];

  assert.deepEqual(
    mergeWorkspaceBuckets(sessions).map(bucket => ({ id:bucket.id, label:bucket.label, ids:bucket.items.map(item => item.id) })),
    [
      { id:'/work/alpha', label:'Alpha', ids:['one', 'two'] },
      { id:'/legacy/c', label:'c', ids:['three'] },
    ],
  );
  assert.deepEqual(
    mergePurposeBuckets(sessions).map(bucket => ({ id:bucket.id, label:bucket.label, ids:bucket.items.map(item => item.id) })),
    [
      { id:'project', label:'项目', ids:['one'] },
      { id:'conversation', label:'对话', ids:['two'] },
      { id:'__purpose_unspecified__', label:'未指定用途', ids:['three'] },
    ],
  );
});

test('Purpose sections preserve pinned tasks and archived access without custom-group editing',()=>{
  const sessions = [
    { id:'one', task:'One', status:'completed', purpose:'project' },
    { id:'pinned', task:'Pinned', status:'completed', purpose:'conversation', pinned:true },
  ];
  const props = { sessions, activeId:null, busy:false, onPreferences:()=>undefined, onSelect:()=>undefined,
    onRename:()=>undefined, onArchive:()=>undefined, onPin:()=>undefined, onOpenArchived:()=>undefined };
  const html=renderToStaticMarkup(<XuenessTaskList {...props} preferences={{view:'purpose',groups:groupFixtures}}/>);
  assert.match(html,/xn-sidebar-item-pinned/);
  assert.match(html,/已归档/);
  assert.doesNotMatch(html,/aria-label="重命名"|xn-task-list__new-group/);
  const custom=renderToStaticMarkup(<XuenessTaskList {...props} preferences={{view:'groups',groups:groupFixtures}}/>);
  assert.match(custom,/aria-label="重命名"/);
  assert.match(custom,/xn-task-list__new-group/);
});

test('Task list hides cached file changes immediately when the files plugin is ineffective',()=>{
  const props = { sessions:[{ id:'changed', task:'Changed', status:'completed', changeSummary:{files:2},
    pendingInteraction:{kind:'userInput'}, unread:true }], activeId:null, busy:false, onPreferences:()=>undefined,
    onSelect:()=>undefined, onRename:()=>undefined, onArchive:()=>undefined, onPin:()=>undefined, onOpenArchived:()=>undefined };
  const enabled=renderToStaticMarkup(<XuenessTaskList {...props} changesEnabled/>);
  assert.match(enabled,/data-change-summary="true"/);
  const disabled=renderToStaticMarkup(<XuenessTaskList {...props} changesEnabled={false}/>);
  assert.doesNotMatch(disabled,/data-change-summary/);
  assert.match(disabled,/data-pending-interaction="true"/);
  assert.match(disabled,/xn-sidebar-unread-label/);
});

test('Timeline view keeps pinned rows unique, attention and task actions, and suppresses compact recent duplicates',()=>{
  const now=new Date(2026,9,14,12).getTime();
  const originalNow=Date.now;
  Date.now=()=>now;
  try {
    const sessions:SessionSummary[]=[
      {id:'today',task:'Today',status:'running',updatedAt:new Date(2026,9,14,11).toISOString(),pendingInteraction:{kind:'userInput'},unread:true},
      {id:'yesterday',task:'Yesterday',status:'completed',updatedAt:new Date(2026,9,13,11).toISOString(),unread:true},
      {id:'unknown',task:'Unknown',status:'completed'},
      {id:'pinned',task:'Pinned',status:'completed',updatedAt:new Date(2026,9,14,10).toISOString(),pinned:true},
      ...Array.from({length:10},(_,index)=>({id:`extra-${index}`,task:`Extra ${index}`,status:'completed',updatedAt:new Date(2026,9,14,9,index).toISOString()})),
    ];
    const props={sessions,activeId:'today',busy:false,preferences:{view:'timeline' as const,groups:groupFixtures},
      onPreferences:()=>undefined,onSelect:()=>undefined,onRename:()=>undefined,onArchive:()=>undefined,onPin:()=>undefined,onOpenArchived:()=>undefined};
    const full=renderToStaticMarkup(<XuenessTaskList {...props}/>);
    assert.match(full,/aria-pressed="true"[^>]*>[\s\S]*?时间线/);
    assert.equal((full.match(/data-session-id="pinned"/gu)??[]).length,1);
    assert.ok(full.indexOf('xn-sidebar-item-pinned')<full.indexOf('data-timeline-bucket="today"'));
    assert.deepEqual([...full.matchAll(/data-timeline-bucket="([^"]+)"/gu)].map(match=>match[1]),['today','yesterday','unknown']);
    assert.match(full,/data-pending-interaction="true"/);
    assert.match(full,/xn-sidebar-unread-label/);
    assert.match(full,/data-testid="xn-sidebar-rename-today"/);
    assert.match(full,/data-testid="xn-sidebar-delete-today"/);
    assert.match(full,/aria-label="已归档"/);
    assert.doesNotMatch(full,/aria-label="重命名"|xn-task-list__new-group|data-project-root/);
    const compact=renderToStaticMarkup(<XuenessTaskList {...props} compact/>);
    for(const session of sessions)assert.equal((compact.match(new RegExp(`data-session-id="${session.id}"`,'gu'))??[]).length,1);
    assert.doesNotMatch(compact,/xn-task-list__recent|xn-sidebar-recent-item-/);
    assert.match(compact,/data-testid="xn-sidebar-menu-today"/);
    assert.match(compact,/aria-label="任务操作"/);
  } finally {Date.now=originalNow;}
});

test('Sidebar collapse-all preserves date folds and project folds in both directions',()=>{
  const collapsed=['/workspace/project','__timeline_today__'];
  assert.deepEqual(toggleSidebarBuckets(collapsed,['__timeline_today__','__timeline_older__']),['/workspace/project']);
  assert.deepEqual(toggleSidebarBuckets(collapsed,['/workspace/project','/workspace/other']),['__timeline_today__']);
  const dates=toggleSidebarBuckets(['/workspace/project'],['__timeline_today__','__timeline_older__']);
  assert.deepEqual(dates,['/workspace/project','__timeline_today__','__timeline_older__']);
  assert.deepEqual(toggleSidebarBuckets(dates,['/workspace/project']),['__timeline_today__','__timeline_older__']);
  assert.deepEqual(toggleSidebarBuckets(collapsed,[]),collapsed);
  assert.deepEqual(collapsed,['/workspace/project','__timeline_today__']);
});

test('Timeline orders each bucket by recency independently of persisted sort and collapses buckets independently',()=>{
  const now=new Date(2026,9,14,12).getTime();
  const originalNow=Date.now;
  Date.now=()=>now;
  try {
    const sessions:SessionSummary[]=[
      {id:'old',task:'A first alphabetically',status:'completed',updatedAt:new Date(2026,9,14,9).toISOString()},
      {id:'new',task:'Z last alphabetically',status:'completed',updatedAt:new Date(2026,9,14,11).toISOString()},
      {id:'yesterday',task:'Yesterday',status:'completed',updatedAt:new Date(2026,9,13,11).toISOString()},
    ];
    const props={sessions,activeId:null,busy:false,onPreferences:()=>undefined,onSelect:()=>undefined,
      onRename:()=>undefined,onArchive:()=>undefined,onPin:()=>undefined,onOpenArchived:()=>undefined};
    for(const sort of ['oldest','name'] as const){
      const preferences:SidebarPreferences={view:'timeline',sort,groups:groupFixtures,collapsed:['unrelated-project']};
      const before=structuredClone(preferences);
      const html=renderToStaticMarkup(<XuenessTaskList {...props} preferences={preferences}/>);
      assert.ok(html.indexOf('data-session-id="new"')<html.indexOf('data-session-id="old"'));
      assert.deepEqual(preferences,before);
    }
    const collapsed=renderToStaticMarkup(<XuenessTaskList {...props} preferences={{view:'timeline',collapsed:['__timeline_today__']}}/>);
    assert.match(collapsed,/data-timeline-bucket="today"[\s\S]*?aria-expanded="false"/);
    assert.doesNotMatch(collapsed,/data-session-id="old"|data-session-id="new"/);
    assert.match(collapsed,/data-timeline-bucket="yesterday"[\s\S]*?aria-expanded="true"/);
    assert.match(collapsed,/data-session-id="yesterday"/);
  } finally {Date.now=originalNow;}
});

test('Timeline renders legacy sessions when sessions-index is unavailable, including unknown timestamps',()=>{
  const legacy:SessionSummary[]=[
    {id:'dated',task:'Dated legacy session',status:'completed',updatedAt:new Date(2020,0,1).toISOString()},
    {id:'unknown',task:'Undated legacy session',status:'completed'},
  ];
  const result=mergeSessionsIndex([],{ok:true,value:legacy},{ok:false,error:'index unavailable'});
  assert.ok(result.ok);
  const html=renderToStaticMarkup(<XuenessTaskList sessions={result.value} activeId={null} busy={false}
    preferences={{view:'timeline'}} onPreferences={()=>undefined} onSelect={()=>undefined} onRename={()=>undefined}
    onArchive={()=>undefined} onPin={()=>undefined} onOpenArchived={()=>undefined}/>);
  assert.match(html,/data-timeline-bucket="older"[\s\S]*?data-session-id="dated"/);
  assert.match(html,/data-timeline-bucket="unknown"[\s\S]*?data-session-id="unknown"/);
});
