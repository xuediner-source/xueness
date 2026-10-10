import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  XuenessTaskList,
  TASK_GROUP_DRAG_MIME,
  dialogFocusWrapIndex,
  isTaskContextMenuShortcut,
  mergeProjectBuckets,
  nextSidebarMenuIndex,
  persistTaskGroupDrop,
  restoreSidebarFocus,
  shouldDismissGroupEditorOnEscape,
} from './XuenessTaskList';
import type { SidebarPreferences, TaskGroup } from './XuenessTaskList';

const groupFixtures:TaskGroup[]=[
  {id:'one',label:'One',taskIds:['task-a','task-b']},
  {id:'two',label:'Two',taskIds:['task-c']},
];

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
