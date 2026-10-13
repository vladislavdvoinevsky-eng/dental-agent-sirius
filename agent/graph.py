"""Граф агента: модель -> (есть tool_calls?) -> инструменты -> модель ... -> ответ.
Свой узел инструментов вместо ToolNode: так личность пациента берётся из сессии
по thread_id, а не из аргументов, которые сгенерировала модель.
"""
import sys
from datetime import datetime
from pathlib import Path
from typing import Annotated, TypedDict

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent.db import connect, get_ctx, get_session, log_chat, log_tool, log_security
from agent import user_mcp
from agent.guard import _forbidden_values, check_input, check_output, clean_history
from agent.llm import make_llm
from agent.mcp_loader import get_mcp_tools
from agent.prompt import PROMPTS
from agent.tools import LOCAL_NAMES, ROLE_TOOLS, is_verified, polite_name, principal, run_local_tool, session_patient

WEEKDAYS_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
MAX_TOOL_ROUNDS = 8                       # защита от зацикливания на один вопрос
SESSION_BOUND_MCP = {"get_treatment_plan"}  # MCP-инструменты, куда patient_id ставит код


class State(TypedDict):
    messages: Annotated[list, add_messages]


def _thread(config: RunnableConfig) -> str:
    return str((config or {}).get("configurable", {}).get("thread_id", "local"))


def _text(result) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, (list, tuple)):
        parts = []
        for x in result:
            if isinstance(x, dict):
                parts.append(str(x.get("text", x)))
            else:
                parts.append(str(getattr(x, "text", x)))
        return "\n".join(parts)
    return str(result)


def _content(m):
    c = m.content
    if isinstance(c, list):
        c = " ".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in c)
    return str(c)


async def call_model(state: State, config: RunnableConfig):
    thread_id = _thread(config)
    if state["messages"] and isinstance(state["messages"][-1], HumanMessage):
        user_text = _content(state["messages"][-1])
        log_chat(thread_id, "user", user_text)
        check_input(thread_id, user_text)
    history = clean_history(thread_id, state["messages"])
    who = principal(thread_id)
    role = who["role"]
    tools = list(ROLE_TOOLS.get(role, []))
    if role == "patient":  # МИС и свои MCP-серверы только у пациента
        tools += await get_mcp_tools() + await user_mcp.tool_specs(thread_id)
    # nostream: токены модели не уходят в браузер по мере генерации. Пользователь видит ответ
    # только после проверки check_output, иначе утечку было бы видно до замены на отказ
    llm = make_llm().bind_tools(tools).with_config(tags=["nostream"])
    if role == "patient":
        status = "не вошёл (данные и запись недоступны, предложи войти по номеру телефона)"
        if who["patient_id"]:
            name = polite_name(who["name"])[1]
            status = f"пациент вошёл, личность подтверждена. Обращайся к нему: {name}" if name else "пациент вошёл"
    elif who["staff_id"]:
        status = f"{'врач' if role == 'doctor' else 'администратор регистратуры'} {who['name']}, вошёл по коду"
    else:
        status = "сотрудник не найден в списке, инструменты недоступны"
    ctx = get_ctx(thread_id)
    if ctx.get("doctor_id"):
        with connect() as con:
            d = con.execute("SELECT d.name, d.specialty, b.name branch FROM doctors d JOIN branches b ON b.id=d.branch_id"
                            " WHERE d.id=?", (ctx["doctor_id"],)).fetchone()
        if d:
            status += (f"\nПоследний обсуждавшийся врач: {d['name']} ({d['specialty']}, {d['branch']}). "
                       "«К ней», «к нему», «к этому врачу» означает его.")
    today = datetime.now()
    system = SystemMessage(PROMPTS.get(role, PROMPTS["patient"]) + f"\n\nСегодня {today:%Y-%m-%d}, {WEEKDAYS_FULL[today.weekday()]}."
                           f"\nСтатус собеседника в этом чате: {status}.")
    response = await llm.ainvoke([system] + history)
    text = _content(response)
    safe = check_output(thread_id, principal(thread_id), text)
    if safe != text:
        response = AIMessage(content=safe, id=response.id)
    if not response.tool_calls:
        log_chat(thread_id, "agent", _content(response))
    return {"messages": [response]}


async def run_tools(state: State, config: RunnableConfig):
    thread_id = _thread(config)
    last = state["messages"][-1]
    role = principal(thread_id)["role"]
    mcp = {t.name: t for t in await get_mcp_tools()} if role == "patient" else {}
    out = []
    for call in last.tool_calls:
        name, args = call["name"], dict(call.get("args") or {})
        try:
            if name == "connect_mcp_server" and role != "patient":
                result = "Этот инструмент недоступен в вашей роли."
            elif name == "connect_mcp_server":
                result = await user_mcp.connect_server(thread_id, args.get("url", ""))
            elif user_mcp.is_user_tool(name) and role == "patient":
                forbidden = _forbidden_values(principal(thread_id))
                code = get_session(thread_id).get("code")
                if code:
                    forbidden.append(("код подтверждения", code))
                result = await user_mcp.call(thread_id, name, args, forbidden)
            elif name in LOCAL_NAMES:
                result = run_local_tool(name, args, thread_id)
            elif name in mcp:
                if name in SESSION_BOUND_MCP:
                    pid = session_patient(thread_id)
                    if not pid:
                        result = "Сначала нужно войти в чат по номеру телефона."
                    else:
                        args["patient_id"] = pid  # значение модели перезаписываем
                        result = await mcp[name].ainvoke(args)
                else:
                    result = await mcp[name].ainvoke(args)
            else:
                result = f"Инструмент {name} не найден."
        except Exception as e:
            result = f"Ошибка инструмента {name}: {e}"
        print(f"[TOOL] {thread_id} {name}({args}) -> {_text(result)[:200]}", flush=True)
        log_tool(thread_id, name, args, _text(result), is_verified(thread_id))
        out.append(ToolMessage(content=_text(result), tool_call_id=call["id"], name=name))
    return {"messages": out}


def route(state: State):
    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        return END
    rounds = 0
    for m in reversed(state["messages"]):
        if isinstance(m, HumanMessage):
            break
        if isinstance(m, AIMessage) and m.tool_calls:
            rounds += 1
    return "tools" if rounds <= MAX_TOOL_ROUNDS else END


builder = StateGraph(State)
builder.add_node("model", call_model)
builder.add_node("tools", run_tools)
builder.add_edge(START, "model")
builder.add_conditional_edges("model", route, {"tools": "tools", END: END})
builder.add_edge("tools", "model")
graph = builder.compile()
