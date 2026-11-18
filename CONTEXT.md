# Audiorective

Audiorective 提供可獨立使用、互相組合的網頁音訊能力。

## Language

**Audio Block（簡稱 Block）**：一塊具有完整功能、能由程式獨立操作並與其他能力組合的 headless 音訊模組。
_Avoid_：以 Audio Primitive 稱呼這類完整功能模組。

**Widget**：可組合、可客製外觀與操作的音訊視覺元件，呈現或操作 Block、參數或音訊資料。可以包含自訂 interaction、renderer、layers 與 plugins。

**Widget Plugin（本專案簡稱 Plugin）**：附加於 Widget 的可選視覺或互動擴充。

**Clip**：可獨立啟動的音訊或 MIDI 片段。

**Scene**：一次要啟動的一組 Clips 的選擇。

**ClipLauncher**：管理 Clip 與 Scene 的啟動、切換及停止的 headless 音訊功能。
_Avoid_：以 Session View 或 Looper 稱呼這項功能。

**Session View**：呈現音軌、Clips 與 Scenes，並讓人操作它們的工作介面。
