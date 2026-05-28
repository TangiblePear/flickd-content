import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import NewAward from "./pages/NewAward";
import EditAward from "./pages/EditAward";
import Winners from "./pages/Winners";

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Flickd Admin</h1>
        <nav>
          <NavLink to="/awards" end>Awards</NavLink>
          <NavLink to="/awards/new">New ceremony</NavLink>
        </nav>
        <footer>
          <small>local-only · 127.0.0.1</small>
        </footer>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/awards" replace />} />
          <Route path="/awards" element={<Home />} />
          <Route path="/awards/new" element={<NewAward />} />
          <Route path="/awards/:slug" element={<EditAward />} />
          <Route path="/awards/:slug/winners" element={<Winners />} />
        </Routes>
      </main>
    </div>
  );
}
