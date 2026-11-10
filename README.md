# 通风对账台（vent-ledger）

关着窗睡一晚、关着窗开一上午会，屋里的 CO₂ 会涨到多少？开窗几分钟能压下来？要装多大新风才够？
把房间的 CO₂ 收支摊成一本可以逐段复算的账。

## 这是什么

单文件网页应用（`index.html`，无依赖、无网络请求）。输入房间尺寸与通风条件、一天的时间线（最多 8 段），
按一阶线性质量平衡逐段算出浓度曲线、峰值、高于目标的时长，并反推「要压到目标需要多大风量 / 要开窗多久」。
附带 15 项结构自检（每次重算都跑）与 9 个内置虚构场景。

## 口径（与页面、说明.txt 完全一致）

```
V  = 面积 × 净层高                                  m³
P  = 60000 × Σ(每人 CO₂ 产生率)                      ppm·m³/h   (1 L/min = 0.06 m³/h，×1e6 → ppm)
Q  = 换气次数 × V + 机械新风                          m³/h
τ  = V / Q                                          h
C_ss = 室外浓度 + P / Q                              ppm
C(t) = C_ss + (C₀ − C_ss)·exp(−t/τ)                 Q > 0
C(t) = C₀ + P·t/V                                   Q = 0（线性上涨）
t* = τ·ln((C₀ − C_ss)/(C_t − C_ss))                 达到目标浓度所需时间
Q_req = P / (C_t − 室外浓度)                        反推所需通风量
稳定日循环：把 24 h 推演看作仿射映射 F(C) = A + B·C，
            B = ∏exp(−时长/τ)、A = F(0)，闭式不动点 C* = A/(1−B)
```

## 目录

| 文件 | 说明 |
|---|---|
| `index.html` | 构建产物（`template.html` + `core.js` + `ui.js`），页面本体 |
| `core.js` | 计算引擎（`window.AppCore`，Node 下也可 `require`） |
| `ui.js` | 界面、SVG 曲线、结果卡 PNG、导出与本机保存 |
| `template.html` | 模板（含 CSS 与 `/*CORE*/`、`/*UI*/` 占位） |
| `build.cjs` | 构建：把 core/ui 内联进模板生成 `index.html` |
| `tests/core.test.cjs` | 核心测试（`node --test tests/core.test.cjs`） |
| `cover.png` | 封面 1200×1200 |

## 本地运行

```
node build.cjs                                  # 生成 index.html
node --test tests/core.test.cjs                 # 核心测试
open index.html                                 # 直接用浏览器打开
```

## 边界

只算 CO₂；单区完全混合、定常产生与定常通风、一阶线性质量平衡。
不建模空间不均匀、开窗风压热压、吸附与化学反应、温湿度与颗粒物；
空气净化器（CADR）在本账里贡献恒为 0；**不引用也不替代任何标准条款**；
不联网、不查产品参数、不做购买建议、不做健康诊断。
默认数据与 9 个内置场景均为虚构示例。
