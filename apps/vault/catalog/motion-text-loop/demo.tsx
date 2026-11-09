import React from "react";import {TextLoop} from "./component";export default function Demo(){return <div className="flex flex-wrap items-center justify-center gap-2 text-xl font-medium"><span className="text-neutral-500">为下一个项目，</span><TextLoop interval={2.5}><span>留住好设计。</span><span>挑选好组件。</span><span>减少重复工作。</span></TextLoop></div>}

