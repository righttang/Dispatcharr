import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Search, X, RefreshCw, Tv } from 'lucide-react';
import API from '../api';
import useChannelsStore from '../store/channels';
import useVideoStore from '../store/useVideoStore';
import { buildLiveStreamUrl } from '../utils/components/FloatingVideoUtils';

const normalized = (value) => String(value || '').toLocaleLowerCase().replace(/[\s_-]+/g, '');
const channelName = (channel) => channel.effective_name || channel.name;
const channelNumber = (channel) => channel.effective_channel_number ?? channel.channel_number;
const groupId = (channel) => channel.effective_channel_group_id ?? channel.channel_group_id;

function ChannelSnapshot({ snapshot }) {
  const [failedUrl, setFailedUrl] = useState('');
  const url = snapshot?.url?.startsWith('/static/channel-thumbnails/') ? snapshot.url : '';
  const show = url && failedUrl !== url && snapshot.captured_at > 0;
  const captured = show ? new Date(snapshot.captured_at * 1000) : null;
  return <span className="mobile-channel-snapshot">
    {show ? <>
      <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(url)} />
      <time dateTime={captured.toISOString()} title={`抓取于 ${captured.toLocaleString('zh-CN')}`}>
        {snapshot.last_attempt_ok === false ? '上次截图' : '截图'} · {captured.toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        })}
      </time>
    </> : <span className="mobile-snapshot-empty"><Tv size={24} aria-hidden="true" /><span>暂无截图</span></span>}
  </span>;
}

export default function MobileChannels({ publicView = false }) {
  const [channels, setChannels] = useState([]);
  const [publicGroups, setPublicGroups] = useState({});
  const [snapshots, setSnapshots] = useState({});
  const [snapshotRefresh, setSnapshotRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const savedGroups = useChannelsStore((state) => state.channelGroups);
  const groups = publicView ? publicGroups : savedGroups;
  const selectedProfileId = useChannelsStore((state) => state.selectedProfileId);
  const profiles = useChannelsStore((state) => state.profiles);
  const showVideo = useVideoStore((state) => state.showVideo);
  const metadata = useVideoStore((state) => state.metadata);
  const isPlaying = useVideoStore((state) => state.isVisible);
  const contentType = useVideoStore((state) => state.contentType);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (publicView) {
        const catalog = await API.getPublicWatchChannels();
        if (!catalog.enabled) {
          setError('请登录后观看频道。');
          return;
        }
        setChannels(catalog.channels);
        setPublicGroups(catalog.groups);
      } else {
        const rows = await API.getChannelsForParams(new URLSearchParams({ ordering: 'channel_number' }));
        setChannels(rows);
      }
    } catch {
      setError('频道暂时没有加载成功，请重试。');
    } finally {
      setLoading(false);
    }
  }, [publicView]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let active = true;
    let controller;
    let timeout;
    const fetchSnapshots = async () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      timeout = window.setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/static/channel-thumbnails/index.json', {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (active && data.channels && typeof data.channels === 'object') setSnapshots(data.channels);
      } catch {
        // Cached screenshots are optional; channel selection stays available.
      } finally {
        window.clearTimeout(timeout);
      }
    };
    fetchSnapshots();
    const interval = window.setInterval(fetchSnapshots, 60000);
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [snapshotRefresh]);

  const available = useMemo(() => {
    const profile = profiles[selectedProfileId];
    return channels.filter((channel) => !channel.hidden_from_output && (
      publicView || !selectedProfileId || String(selectedProfileId) === '0' || !profile || profile.channels.has(channel.id)
    )).sort((a, b) => (channelNumber(a) ?? Infinity) - (channelNumber(b) ?? Infinity)
      || channelName(a).localeCompare(channelName(b)));
  }, [channels, selectedProfileId, profiles, publicView]);

  const categories = useMemo(() => {
    const found = new Map();
    for (const channel of available) {
      const id = groupId(channel);
      if (id == null) continue;
      found.set(String(id), groups[id]?.name || '其他频道');
    }
    return [...found.entries()];
  }, [available, groups]);

  const visible = available.filter((channel) => (
    (group === 'all' || String(groupId(channel)) === group)
    && normalized(channelName(channel)).includes(normalized(search))
  ));
  const hasPlayer = isPlaying && contentType === 'live';

  const watch = (channel) => {
    const path = buildLiveStreamUrl(`/proxy/ts/stream/${channel.uuid}`, { useSavedProfile: !publicView });
    showVideo(`${window.location.origin}${path}`, 'live', {
      name: channelName(channel), channelId: channel.id,
      streamProfileId: channel.effective_stream_profile_id ?? channel.stream_profile_id,
      ...(publicView ? { publicView: true, nativeOutputProfileId: channel.native_output_profile_id } : {}),
    });
  };

  return (
    <section className={`mobile-watch${hasPlayer ? ' has-player' : ''}`} aria-label="手机频道列表">
      {hasPlayer && <div className="mobile-player-space" aria-hidden="true" />}
      <div className="mobile-watch-heading">
        <div>
          <p className="mobile-watch-eyebrow">LIVE TV</p>
          <h1>选台 <span>{available.length} 个频道</span></h1>
        </div>
        <button type="button" className="mobile-refresh" aria-label="刷新频道" disabled={loading}
          onClick={() => { load(); setSnapshotRefresh((value) => value + 1); }}>
          <RefreshCw size={19} className={loading ? 'mobile-spin' : ''} />
        </button>
      </div>
      <p className="mobile-snapshot-note">频道画面定时更新 · 时间见图片角标</p>
      {hasPlayer && <p className="mobile-now-playing"><span />正在播放：{metadata?.name}</p>}
      <div className="mobile-channel-tools">
        <div className="mobile-search">
          <Search size={20} aria-hidden="true" />
          <input type="search" aria-label="搜索频道" placeholder="搜索频道，如 CCTV-13" value={search}
            onChange={(event) => setSearch(event.target.value)} autoComplete="off" />
          {search && <button type="button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={18} /></button>}
        </div>
        <div className="mobile-categories" aria-label="频道分组">
          <button type="button" aria-pressed={group === 'all'} onClick={() => setGroup('all')}>全部</button>
          {categories.map(([id, name]) => <button type="button" key={id} aria-pressed={group === id}
            onClick={() => setGroup(id)}>{name.replace(/^[^\p{L}\p{N}]+/u, '')}</button>)}
        </div>
      </div>
      {loading && channels.length === 0 && <p className="mobile-empty" role="status">正在加载频道…</p>}
      {error && <div className="mobile-empty" role="alert"><p>{error}</p><button type="button" onClick={load}>重新加载</button></div>}
      {!loading && !error && visible.length === 0 && (
        <div className="mobile-empty"><Tv size={28} /><p>{search ? '没有找到匹配的频道' : '这个分组暂时没有频道'}</p>
          {(search || group !== 'all') && <button type="button" onClick={() => { setSearch(''); setGroup('all'); }}>查看全部频道</button>}
        </div>
      )}
      <div className="mobile-channel-grid">
        {visible.map((channel) => {
          const playing = hasPlayer && metadata?.channelId === channel.id;
          return <button type="button" className={`mobile-channel-card${playing ? ' is-playing' : ''}`}
            key={channel.id} aria-label={`播放 ${channelName(channel)}`} aria-pressed={playing} onClick={() => watch(channel)}>
            <ChannelSnapshot snapshot={snapshots[channel.uuid]} />
            <span className="mobile-channel-details">
              <span className="mobile-channel-number">{channelNumber(channel) ?? 'TV'}</span>
              <span className="mobile-channel-copy"><strong>{channelName(channel)}</strong>
                <small>{playing ? '正在播放' : groups[groupId(channel)]?.name?.replace(/^[^\p{L}\p{N}]+/u, '') || '电视直播'}</small>
              </span>
              <Play size={17} fill="currentColor" className="mobile-channel-play" aria-hidden="true" />
            </span>
          </button>;
        })}
      </div>
      {!loading && !error && visible.length > 0 && <p className="mobile-channel-total">显示 {visible.length} 个频道 · 点选即可播放</p>}
    </section>
  );
}
