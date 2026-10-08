import { Avatar, Icon, STATUS_LABEL } from "../util.jsx";

export default function AccountRail({ accounts, status, unread, activeId, onSelect, onAdd, canAdd }) {
  return (
    <nav className="rail" aria-label="Accounts">
      <div className="rail-logo" title="SnapBot">👻</div>
      <div className="rail-accounts">
        {accounts.map((a) => {
          const s = status[a.id]?.status || a.status;
          const count = Object.values(unread[a.id] || {}).reduce((n, ids) => n + ids.length, 0);
          return (
            <button
              key={a.id}
              className={`rail-account ${a.id === activeId ? "active" : ""}`}
              title={`${a.label} · ${STATUS_LABEL[s] || s}`}
              onClick={() => onSelect(a.id)}
            >
              <Avatar name={a.label} size={40}>
                <span className={`dot ${s}`} />
              </Avatar>
              {count > 0 && <span className="badge">{count > 99 ? "99+" : count}</span>}
            </button>
          );
        })}
      </div>
      <button className="rail-add" title={canAdd ? "Add account" : "Account limit reached"} onClick={onAdd} disabled={!canAdd}>
        <Icon name="plus" />
      </button>
    </nav>
  );
}
