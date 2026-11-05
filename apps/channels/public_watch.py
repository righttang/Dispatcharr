"""Read-only public channel catalog and anonymous viewer session teardown."""

import os

from django.http import JsonResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods, require_safe

from apps.channels.models import Channel
from apps.proxy.live_proxy.output.hls.session import get_hls_session
from apps.proxy.live_proxy.services.channel_service import ChannelService
from core.models import OutputProfile
from core.utils import RedisClient
from dispatcharr.utils import network_access_allowed


def public_watch_enabled():
    return os.environ.get("DISPATCHARR_PUBLIC_WATCH", "0").lower() in ("1", "true", "yes")


@require_safe
def channel_catalog(request):
    if not public_watch_enabled():
        return JsonResponse({"enabled": False, "channels": [], "groups": {}})
    if not network_access_allowed(request, "STREAMS"):
        return JsonResponse({"error": "Forbidden"}, status=403)

    compatibility_id = OutputProfile.objects.filter(
        name="IPTV AirPlay compatibility", is_active=True
    ).values_list("id", flat=True).first()
    queryset = Channel.objects.with_effective_values(select_related_fks=True).filter(
        hidden_from_output=False, effective_is_radio=False, streams__isnull=False
    ).select_related("channel_group", "stream_profile").distinct()
    channels, groups = [], {}
    for channel in queryset:
        group = channel.effective_channel_group_obj
        if group:
            groups[str(group.id)] = {"id": group.id, "name": group.name}
        source = channel.effective_stream_profile_obj
        already_compatible = bool(
            source and source.name.startswith("IPTV Dynamic ")
            and all(flag in source.parameters for flag in (
                "-c:v libx264", "-preset ultrafast", "-tune zerolatency", "-c:a aac"
            ))
        )
        channels.append({
            "id": channel.id,
            "uuid": str(channel.uuid),
            "name": channel.effective_name,
            "channel_number": channel.effective_channel_number,
            "channel_group_id": channel.effective_channel_group_id,
            "native_output_profile_id": None if already_compatible else compatibility_id,
        })
    response = JsonResponse({"enabled": True, "channels": channels, "groups": groups})
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_http_methods(["DELETE"])
def destroy_anonymous_session(request, token):
    if not public_watch_enabled():
        return JsonResponse({"error": "Not found"}, status=404)
    if not network_access_allowed(request, "STREAMS"):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if len(token) > 128:
        return JsonResponse({"error": "Session not found"}, status=404)
    session = get_hls_session(RedisClient.get_client(), token)
    if not session or str(session.get("user_id")) != "0":
        return JsonResponse({"error": "Session not found"}, status=404)
    ChannelService.stop_client(session["channel_id"], session["client_id"])
    return HttpResponse(status=204)
