import React from "react";import {AnimatedSubscribeButton} from "./component";export default function Demo(){return <div className="flex flex-col items-center gap-5"><AnimatedSubscribeButton><span>订阅组件更新 →</span><span>✓ 已订阅</span></AnimatedSubscribeButton><p className="text-xs text-muted-foreground">点击切换状态 · 演示不会发送订阅请求</p></div>}

